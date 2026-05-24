import { log, ApplicationFailure } from "@temporalio/activity";
import type { MemoryClient, SearchHit } from "@temporal-memory/memory-adapter";
import { MemoryClientError } from "@temporal-memory/memory-adapter";
import type {
  ApprovalRequestInput,
  ApprovalResult,
  ApprovalStatus,
} from "./shared.js";

/**
 * Map MemoryClientError (4xx, except 429) to a non-retryable ApplicationFailure so
 * Temporal's `nonRetryableErrorTypes` policy short-circuits auth problems. Same
 * helper pattern as T01 — kept private here until the duplication grows large
 * enough to justify extracting into the memory-adapter package.
 *
 * - 4xx (except 429) → MemoryAuthError (nonRetryable)
 * - 429 + 5xx + status === undefined (network/parse/abort) → retryable, falls through
 */
function rethrowMemoryError(err: unknown, op: string): never {
  if (err instanceof MemoryClientError && typeof err.status === "number") {
    const isClientError = err.status >= 400 && err.status < 500 && err.status !== 429;
    if (isClientError) {
      throw ApplicationFailure.create({
        message: `${op} failed with ${err.status}: ${err.message}`,
        type: "MemoryAuthError",
        nonRetryable: true,
      });
    }
  }
  throw err;
}

/**
 * Pluggable side-effect for telling a human "please approve this." Default
 * implementation just logs to the worker process; production deployments wire
 * this to Telegram, mail, Slack, etc.
 */
export type Notifier = (input: {
  taskId: string;
  title: string;
  description: string;
  context: SearchHit[];
}) => Promise<void>;

/** Pluggable executor that runs only after the operator approves. */
export type Executor = (input: {
  taskId: string;
  payload?: Record<string, unknown>;
  approver: string;
}) => Promise<unknown>;

const defaultNotifier: Notifier = async ({ taskId, title }) => {
  console.log(`[notifier] approval requested for ${taskId}: ${title}`);
};

const defaultExecutor: Executor = async ({ taskId, approver }) => {
  return { taskId, executedBy: approver, ok: true };
};

export interface ActivityDeps {
  memory: MemoryClient;
  notifier?: Notifier;
  executor?: Executor;
}

export function createActivities(deps: ActivityDeps) {
  const notifier = deps.notifier ?? defaultNotifier;
  const executor = deps.executor ?? defaultExecutor;

  return {
    /** Search memory for context that helps the operator decide. */
    async searchContext(input: ApprovalRequestInput): Promise<SearchHit[]> {
      log.info("searchContext", { taskId: input.taskId });
      try {
        return await deps.memory.search(input.title, {
          project: input.memoryProject,
          limit: 5,
        });
      } catch (err) {
        return rethrowMemoryError(err, "searchContext");
      }
    },

    /** Best-effort notify — failure does not block the workflow. */
    async notifyOperator(input: {
      taskId: string;
      title: string;
      description: string;
      context: SearchHit[];
    }): Promise<void> {
      log.info("notifyOperator", { taskId: input.taskId });
      try {
        await notifier(input);
      } catch (err) {
        log.warn("notifyOperator failed; continuing", { err: String(err) });
      }
    },

    /** Run the actual approved action. Only called when status === "approved". */
    async executeApprovedAction(input: {
      taskId: string;
      payload?: Record<string, unknown>;
      approver: string;
    }): Promise<unknown> {
      log.info("executeApprovedAction", { taskId: input.taskId, approver: input.approver });
      return executor(input);
    },

    /**
     * Persist the final outcome to memory as a Decision. Returns the decision ID
     * or null if the memory backend was unavailable — caller decides whether to
     * propagate the failure upward.
     */
    async persistOutcome(input: {
      taskId: string;
      title: string;
      status: ApprovalStatus;
      approver?: string;
      reason?: string;
      project?: string;
      executedSummary?: string;
    }): Promise<{ id: string | null }> {
      log.info("persistOutcome", { taskId: input.taskId, status: input.status });
      try {
        const decisionTitle = `${input.title} — ${input.status}`;
        const decisionBody = [
          `Status: ${input.status}`,
          input.approver ? `Approver: ${input.approver}` : null,
          input.reason ? `Reason: ${input.reason}` : null,
          input.executedSummary ? `Executed: ${input.executedSummary}` : null,
        ]
          .filter(Boolean)
          .join("\n");
        const res = await deps.memory.decide({
          title: decisionTitle.slice(0, 500),
          decision: decisionBody.slice(0, 5000),
          project: input.project,
          tags: ["t02", `approval-${input.status}`],
          confidence: input.status === "approved" ? 0.9 : 0.6,
        });
        return { id: res.id };
      } catch (err) {
        return rethrowMemoryError(err, "persistOutcome");
      }
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;

/** Helper for tests + callers that want to construct a plain ApprovalResult. */
export function buildResult(
  taskId: string,
  status: ApprovalStatus,
  decisionId: string | null,
  extras: Partial<ApprovalResult> = {},
): ApprovalResult {
  return {
    taskId,
    status,
    decisionId,
    ...extras,
  };
}
