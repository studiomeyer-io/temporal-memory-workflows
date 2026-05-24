import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  log,
  ApplicationFailure,
} from "@temporalio/workflow";
import type { Activities } from "./activities.js";
import type {
  ApprovalRequestInput,
  ApprovalResult,
  ApprovalSignalPayload,
  ApprovalStatus,
} from "./shared.js";
import { APPROVAL_SIGNAL_NAME, STATUS_QUERY_NAME } from "./shared.js";

/**
 * Signal that the operator (or any caller with workflow handle access) sends
 * when they decide. The handler captures it; the workflow body unblocks via
 * `condition()`.
 */
export const approvalSignal = defineSignal<[ApprovalSignalPayload]>(APPROVAL_SIGNAL_NAME);

/** Query so external observers can inspect the current status without waiting. */
export const statusQuery = defineQuery<ApprovalStatus>(STATUS_QUERY_NAME);

// Critical-path activities — must succeed or the workflow fails.
const critical = proxyActivities<
  Pick<Activities, "searchContext" | "executeApprovedAction" | "persistOutcome">
>({
  startToCloseTimeout: "30 seconds",
  retry: {
    initialInterval: "1s",
    maximumAttempts: 3,
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ["MemoryAuthError", "InvalidInput"],
  },
});

// Best-effort notify — Telegram / mail outages do not block the workflow.
const bestEffort = proxyActivities<Pick<Activities, "notifyOperator">>({
  startToCloseTimeout: "10 seconds",
  retry: { maximumAttempts: 1 },
});

/**
 * T02 — Operator Approval Workflow.
 *
 *   Input → searchContext → notifyOperator (best-effort) → wait for signal | timeout
 *      ├─ approved  → executeApprovedAction → persistOutcome → result
 *      ├─ rejected  →                       → persistOutcome → result
 *      └─ timed-out →                       → persistOutcome → throw ApplicationFailure(ApprovalTimeout)
 *
 * Durable across worker crashes thanks to Temporal's event history replay.
 * The wait can span hours, days, or weeks — Temporal does not occupy a worker
 * slot while idle.
 */
export async function operatorApprovalWorkflow(
  input: ApprovalRequestInput,
): Promise<ApprovalResult> {
  if (!input.taskId || !input.title) {
    throw ApplicationFailure.create({
      message: "taskId and title are required",
      type: "InvalidInput",
      nonRetryable: true,
    });
  }

  let status: ApprovalStatus = "awaiting";
  let signalPayload: ApprovalSignalPayload | null = null;

  setHandler(statusQuery, () => status);
  setHandler(approvalSignal, (payload) => {
    // Idempotent: only the first signal counts. Late signals are ignored so a
    // late approver does not race with a timeout.
    if (signalPayload !== null) {
      log.warn("approval signal received after decision; ignoring", {
        approver: payload.approver,
      });
      return;
    }
    signalPayload = payload;
  });

  log.info("operatorApprovalWorkflow start", { taskId: input.taskId });

  const context = await critical.searchContext(input);

  await bestEffort.notifyOperator({
    taskId: input.taskId,
    title: input.title,
    description: input.description,
    context,
  });

  const timeout = input.approvalTimeout ?? "7 days";
  // condition() returns true if the predicate became truthy, false if the timeout fired.
  const decided = await condition(() => signalPayload !== null, timeout);

  if (!decided) {
    status = "timed-out";
    log.info("approval timed out", { taskId: input.taskId, timeout });
    const persisted = await critical.persistOutcome({
      taskId: input.taskId,
      title: input.title,
      status,
      reason: `no signal received within ${timeout}`,
      project: input.memoryProject,
    });
    throw ApplicationFailure.create({
      message: `approval for ${input.taskId} timed out after ${timeout}`,
      type: "ApprovalTimeout",
      nonRetryable: true,
      details: [{
        taskId: input.taskId,
        decisionId: persisted.id,
      }],
    });
  }

  const decision = signalPayload as unknown as ApprovalSignalPayload;
  status = decision.approved ? "approved" : "rejected";
  log.info("approval decision received", {
    taskId: input.taskId,
    status,
    approver: decision.approver,
  });

  let executedResult: unknown;
  let executedSummary: string | undefined;
  if (status === "approved") {
    executedResult = await critical.executeApprovedAction({
      taskId: input.taskId,
      payload: input.payload,
      approver: decision.approver,
    });
    executedSummary = typeof executedResult === "string"
      ? executedResult
      : JSON.stringify(executedResult).slice(0, 1000);
  }

  const persisted = await critical.persistOutcome({
    taskId: input.taskId,
    title: input.title,
    status,
    approver: decision.approver,
    reason: decision.reason,
    project: input.memoryProject,
    executedSummary,
  });

  return {
    taskId: input.taskId,
    status,
    approver: decision.approver,
    reason: decision.reason,
    decisionId: persisted.id,
    ...(executedResult !== undefined ? { executedResult } : {}),
  };
}
