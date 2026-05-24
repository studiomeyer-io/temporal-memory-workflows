import { log, ApplicationFailure } from "@temporalio/activity";
import type { MemoryClient } from "@temporal-memory/memory-adapter";
import { MemoryClientError } from "@temporal-memory/memory-adapter";
import type { ChildAgentInput, ChildAgentResult, CoordinatorInput } from "./shared.js";

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
 * Pluggable agent worker. Production deployments wire this to an LLM call.
 * Default deterministic stub: echoes the prompt with a sub-task label.
 */
export type AgentWorker = (input: ChildAgentInput) => Promise<string>;

const defaultWorker: AgentWorker = async ({ subTaskId, prompt }) => {
  return `Result for ${subTaskId}: ${prompt}`;
};

export interface ActivityDeps {
  memory: MemoryClient;
  worker?: AgentWorker;
}

export function createActivities(deps: ActivityDeps) {
  const worker = deps.worker ?? defaultWorker;

  return {
    /** Child-side activity: runs the actual agent work for one sub-task. */
    async doAgentWork(input: ChildAgentInput): Promise<string> {
      log.info("doAgentWork", { subTaskId: input.subTaskId });
      return worker(input);
    },

    /**
     * Child-side activity: persists the child's learning with the shared coord tag.
     * The tag is the glue — sibling children + the parent can all be retrieved
     * by searching for `coord:<coordinationId>`.
     */
    async persistAgentResult(input: {
      child: ChildAgentInput;
      output: string;
    }): Promise<{ id: string | null }> {
      try {
        const res = await deps.memory.learn({
          category: "research",
          content: `[${input.child.subTaskId}] ${input.child.prompt}\n→ ${input.output}`,
          project: input.child.memoryProject,
          tags: [
            "t05",
            `coord:${input.child.coordinationId}`,
            `agent:${input.child.subTaskId}`,
          ],
          confidence: 0.75,
        });
        return { id: res.id };
      } catch (err) {
        return rethrowMemoryError(err, "persistAgentResult");
      }
    },

    /**
     * Parent-side activity: aggregates child results into a human-readable summary.
     * Deterministic by default — production deployments can wire this to an LLM
     * for proper synthesis.
     */
    async aggregateChildResults(input: {
      coordinator: CoordinatorInput;
      children: ChildAgentResult[];
    }): Promise<string> {
      log.info("aggregateChildResults", {
        coordinationId: input.coordinator.coordinationId,
        children: input.children.length,
      });
      const success = input.children.filter((c) => c.status === "completed");
      const failed = input.children.filter((c) => c.status === "failed");
      const header = `Coordination "${input.coordinator.topic}" (${input.coordinator.coordinationId}): ${success.length}/${input.children.length} children completed.`;
      const successLines = success.map((c) => `✓ ${c.subTaskId}: ${(c.output ?? "").slice(0, 200)}`);
      const failureLines = failed.length > 0
        ? ["", "Failures:", ...failed.map((c) => `✗ ${c.subTaskId}: ${c.error ?? "unknown error"}`)]
        : [];
      return [header, "", ...successLines, ...failureLines].join("\n");
    },

    /**
     * Parent-side activity: persists the final synthesis as a Decision tagged with
     * the same coord ID, so all siblings + the parent appear in one memory query.
     */
    async persistCoordination(input: {
      coordinator: CoordinatorInput;
      successCount: number;
      failureCount: number;
      summary: string;
    }): Promise<{ id: string | null }> {
      try {
        const res = await deps.memory.decide({
          title: `Coordination ${input.coordinator.topic} (${input.coordinator.coordinationId})`,
          decision: input.summary.slice(0, 5000),
          reasoning: `${input.successCount} success, ${input.failureCount} failure out of ${input.coordinator.subTasks.length} children`,
          project: input.coordinator.memoryProject,
          tags: [
            "t05",
            "coordination-result",
            `coord:${input.coordinator.coordinationId}`,
          ],
          confidence: input.failureCount === 0 ? 0.9 : Math.max(0.4, 0.9 - 0.1 * input.failureCount),
        });
        return { id: res.id };
      } catch (err) {
        return rethrowMemoryError(err, "persistCoordination");
      }
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
