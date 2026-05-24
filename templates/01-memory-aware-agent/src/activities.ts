import { log, ApplicationFailure } from "@temporalio/activity";
import type {
  LearningCategory,
  MemoryClient,
  SearchHit,
} from "@temporal-memory/memory-adapter";
import { MemoryClientError } from "@temporal-memory/memory-adapter";

/**
 * Map a MemoryClientError to a Temporal ApplicationFailure so the workflow's
 * `nonRetryableErrorTypes` policy can short-circuit auth/validation problems
 * instead of burning retries on errors that will never resolve.
 *
 * - 4xx (except 429): non-retryable → MemoryAuthError
 * - 429 + 5xx + network: retryable, falls through as-is
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

export interface ActivitySearchInput {
  question: string;
  project?: string;
  limit?: number;
}

export interface ActivityLearnInput {
  content: string;
  category?: LearningCategory;
  project?: string;
  tags?: string[];
}

/**
 * Optional override for the reasoning step. Receives the question + retrieved hits and returns the answer.
 * Real deployments swap this for an Anthropic / OpenAI client. The default is a deterministic stub so the
 * template runs end-to-end without an LLM key.
 */
export type Reasoner = (input: { question: string; hits: SearchHit[] }) => Promise<string>;

export interface ActivityDeps {
  memory: MemoryClient;
  reasoner?: Reasoner;
}

const defaultReasoner: Reasoner = async ({ question, hits }) => {
  if (hits.length === 0) {
    return `No prior memory found for "${question}". Suggest investigating fresh.`;
  }
  const summary = hits
    .slice(0, 3)
    .map((h, i) => `[${i + 1}] ${h.content.slice(0, 200)}`)
    .join("\n");
  return `Question: ${question}\nFound ${hits.length} memory hits. Top items:\n${summary}`;
};

/**
 * Build the activity bundle bound to a specific MemoryClient + reasoner.
 * Workers register the returned record; workflow code calls them via `proxyActivities`.
 */
export function createActivities(deps: ActivityDeps) {
  const reasoner = deps.reasoner ?? defaultReasoner;

  return {
    async searchMemory(input: ActivitySearchInput): Promise<SearchHit[]> {
      log.info("searchMemory", { question: input.question, project: input.project });
      try {
        return await deps.memory.search(input.question, {
          project: input.project,
          limit: input.limit ?? 10,
        });
      } catch (err) {
        rethrowMemoryError(err, "searchMemory");
      }
    },

    async reason(input: { question: string; hits: SearchHit[] }): Promise<string> {
      log.info("reason", { question: input.question, hits: input.hits.length });
      return reasoner(input);
    },

    async persistLearning(input: ActivityLearnInput): Promise<{ id: string }> {
      log.info("persistLearning", { contentLength: input.content.length });
      try {
        const res = await deps.memory.learn({
          content: input.content,
          category: input.category ?? "workflow",
          project: input.project,
          tags: input.tags,
        });
        return { id: res.id };
      } catch (err) {
        rethrowMemoryError(err, "persistLearning");
      }
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
