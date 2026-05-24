import { proxyActivities, executeChild, log, ApplicationFailure } from "@temporalio/workflow";
import type { Activities } from "./activities.js";
import type {
  ChildAgentInput,
  ChildAgentResult,
  CoordinatorInput,
  CoordinatorResult,
} from "./shared.js";
import { MAX_SUBTASKS, WORKFLOW_ID_PREFIX } from "./shared.js";

const critical = proxyActivities<
  Pick<
    Activities,
    "doAgentWork" | "persistAgentResult" | "aggregateChildResults" | "persistCoordination"
  >
>({
  startToCloseTimeout: "1 minute",
  retry: {
    initialInterval: "1s",
    maximumAttempts: 3,
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ["MemoryAuthError", "InvalidInput"],
  },
});

/**
 * CHILD workflow — one per sub-task. Spawned by the coordinator via executeChild.
 *
 * doAgentWork → persistAgentResult → return ChildAgentResult
 *
 * Catches its own errors and returns `status: "failed"` so the coordinator
 * sees a uniform array instead of a thrown rejection. The coordinator decides
 * whether to tolerate failures (input.tolerateChildFailures).
 */
export async function agentTaskWorkflow(input: ChildAgentInput): Promise<ChildAgentResult> {
  if (!input.coordinationId || !input.subTaskId) {
    throw ApplicationFailure.create({
      message: "coordinationId and subTaskId are required",
      type: "InvalidInput",
      nonRetryable: true,
    });
  }
  log.info("agentTaskWorkflow start", { subTaskId: input.subTaskId });

  try {
    const output = await critical.doAgentWork(input);
    const persisted = await critical.persistAgentResult({ child: input, output });
    return {
      subTaskId: input.subTaskId,
      status: "completed",
      output,
      learningId: persisted.id,
    };
  } catch (err) {
    log.warn("agentTaskWorkflow failed", { subTaskId: input.subTaskId, err: String(err) });
    return {
      subTaskId: input.subTaskId,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      learningId: null,
    };
  }
}

/**
 * PARENT (Coordinator) workflow — spawns N child workflows in parallel.
 *
 *   executeChild × N (parallel via Promise.all)
 *     → aggregateChildResults
 *     → persistCoordination
 *     → CoordinatorResult
 *
 * Each child runs in its own workflow execution with its own event history.
 * The parent's history only records "child started" + "child completed" events,
 * not the full child history — keeps the parent lightweight even with many children.
 *
 * Shared `coord:<coordinationId>` tag glues all children + parent in memory.
 * One memory.search({tags: ["coord:<id>"]}) returns the full trail.
 */
export async function multiAgentCoordinatorWorkflow(
  input: CoordinatorInput,
): Promise<CoordinatorResult> {
  if (!input.coordinationId || !input.topic) {
    throw ApplicationFailure.create({
      message: "coordinationId and topic are required",
      type: "InvalidInput",
      nonRetryable: true,
    });
  }
  if (!input.subTasks || input.subTasks.length === 0) {
    throw ApplicationFailure.create({
      message: "at least one sub-task is required",
      type: "InvalidInput",
      nonRetryable: true,
    });
  }
  if (input.subTasks.length > MAX_SUBTASKS) {
    throw ApplicationFailure.create({
      message: `too many sub-tasks (${input.subTasks.length}); max is ${MAX_SUBTASKS}`,
      type: "InvalidInput",
      nonRetryable: true,
    });
  }

  log.info("multiAgentCoordinatorWorkflow start", {
    coordinationId: input.coordinationId,
    childCount: input.subTasks.length,
  });

  // Spawn all children in parallel. executeChild returns a promise that resolves
  // when the child workflow completes (or rejects when it throws).
  const childPromises = input.subTasks.map((sub) => {
    const childInput: ChildAgentInput = {
      coordinationId: input.coordinationId,
      subTaskId: sub.subTaskId,
      name: sub.name,
      prompt: sub.prompt,
      memoryProject: input.memoryProject,
    };
    return executeChild(agentTaskWorkflow, {
      args: [childInput],
      workflowId: `${WORKFLOW_ID_PREFIX}-child-${input.coordinationId}-${sub.subTaskId}`,
    });
  });

  let children: ChildAgentResult[];
  if (input.tolerateChildFailures) {
    // Promise.allSettled lets the parent continue even if some children threw
    // an unrecoverable error (e.g. InvalidInput on a child workflow itself).
    const settled = await Promise.allSettled(childPromises);
    children = settled.map((s, i) => {
      const sub = input.subTasks[i]!;
      if (s.status === "fulfilled") return s.value;
      // Child workflow itself threw — wrap as a failed ChildAgentResult.
      return {
        subTaskId: sub.subTaskId,
        status: "failed",
        error: s.reason instanceof Error ? s.reason.message : String(s.reason),
        learningId: null,
      };
    });
  } else {
    // Default: parent re-throws as soon as any child workflow throws.
    children = await Promise.all(childPromises);
  }

  const successCount = children.filter((c) => c.status === "completed").length;
  const failureCount = children.filter((c) => c.status === "failed").length;

  const summary = await critical.aggregateChildResults({
    coordinator: input,
    children,
  });

  const persisted = await critical.persistCoordination({
    coordinator: input,
    successCount,
    failureCount,
    summary,
  });

  log.info("multiAgentCoordinatorWorkflow done", {
    coordinationId: input.coordinationId,
    successCount,
    failureCount,
    decisionId: persisted.id,
  });

  return {
    coordinationId: input.coordinationId,
    topic: input.topic,
    childCount: children.length,
    successCount,
    failureCount,
    children,
    summary,
    decisionId: persisted.id,
  };
}
