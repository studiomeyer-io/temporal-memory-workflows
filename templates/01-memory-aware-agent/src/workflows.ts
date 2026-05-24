import { proxyActivities, log, ApplicationFailure } from "@temporalio/workflow";
import type { Activities } from "./activities.js";
import type { AgentTaskInput, AgentTaskResult } from "./shared.js";

// Critical-path activities (searchMemory, reason) — must succeed or the workflow fails.
// nonRetryableErrorTypes covers auth and validation errors that won't resolve via retry.
const critical = proxyActivities<Pick<Activities, "searchMemory" | "reason">>({
  startToCloseTimeout: "30 seconds",
  retry: {
    initialInterval: "1s",
    maximumAttempts: 3,
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ["MemoryAuthError", "InvalidInput"],
  },
});

// Best-effort persist — never delays the workflow's success path.
// Single attempt, short timeout, failure swallowed via try/catch in the workflow body.
const bestEffort = proxyActivities<Pick<Activities, "persistLearning">>({
  startToCloseTimeout: "10 seconds",
  retry: {
    maximumAttempts: 1,
  },
});

/**
 * T01 — Memory-Aware Agent Workflow.
 *
 * Read → Reason → Write. Durable across crashes. The persist step is best-effort:
 * if memory is unavailable, the answer still returns and we record `learningId: null`
 * so callers can detect drift without losing the result.
 */
export async function memoryAwareAgentWorkflow(input: AgentTaskInput): Promise<AgentTaskResult> {
  if (!input.taskId || !input.question) {
    throw ApplicationFailure.create({
      message: "taskId and question are required",
      type: "InvalidInput",
      nonRetryable: true,
    });
  }
  log.info("memoryAwareAgentWorkflow start", { taskId: input.taskId });

  const hits = await critical.searchMemory({
    question: input.question,
    project: input.memoryProject,
    limit: input.memoryLimit,
  });

  const answer = await critical.reason({ question: input.question, hits });

  let learningId: string | null = null;
  try {
    const persisted = await bestEffort.persistLearning({
      content: `Q: ${input.question}\nA: ${answer}`,
      category: "workflow",
      project: input.memoryProject,
      tags: ["t01", "agent-output"],
    });
    learningId = persisted.id;
  } catch (err) {
    // Persist is best-effort. Log and continue.
    log.warn("persistLearning failed; returning answer without learningId", { err: String(err) });
  }

  log.info("memoryAwareAgentWorkflow done", {
    taskId: input.taskId,
    memoryHits: hits.length,
    learningId,
  });

  return {
    taskId: input.taskId,
    answer,
    memoryHits: hits.length,
    learningId,
  };
}
