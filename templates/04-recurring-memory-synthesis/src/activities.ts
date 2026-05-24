import { log, ApplicationFailure } from "@temporalio/activity";
import type { MemoryClient, SearchHit } from "@temporal-memory/memory-adapter";
import { MemoryClientError } from "@temporal-memory/memory-adapter";
import type { SynthesisCluster, SynthesisInput } from "./shared.js";

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
 * Pluggable summarizer. Receives all gathered clusters + raw hits and returns
 * a human-readable summary string. Default is deterministic — counts + tag-cloud
 * style snippet — so the template runs end-to-end without an LLM key.
 */
export type Summarizer = (input: {
  windowDays: number;
  clusters: SynthesisCluster[];
  totalItems: number;
}) => Promise<string>;

const defaultSummarizer: Summarizer = async ({ windowDays, clusters, totalItems }) => {
  if (totalItems === 0) {
    return `No new memory items in the last ${windowDays} days.`;
  }
  const headline = `Aggregated ${totalItems} memory items across ${clusters.length} topic(s) in the last ${windowDays} days.`;
  const lines = clusters
    .filter((c) => c.hitCount > 0)
    .sort((a, b) => b.hitCount - a.hitCount)
    .map((c) => `- ${c.topic}: ${c.hitCount} items${c.highlights[0] ? ` (top: ${c.highlights[0].slice(0, 80)}...)` : ""}`);
  return [headline, "", ...lines].join("\n");
};

export interface ActivityDeps {
  memory: MemoryClient;
  summarizer?: Summarizer;
  /**
   * Allows tests to inject a fixed "now" so deterministic-ish output across runs
   * is achievable. In production, undefined → Date.now() (called from an Activity,
   * so non-determinism is safe).
   */
  now?: () => Date;
}

export function createActivities(deps: ActivityDeps) {
  const summarizer = deps.summarizer ?? defaultSummarizer;
  const now = deps.now ?? (() => new Date());

  return {
    /** Runs one memory search per topic and folds them into clusters. */
    async gatherLearnings(input: SynthesisInput): Promise<{ clusters: SynthesisCluster[]; totalItems: number }> {
      log.info("gatherLearnings", { topics: input.topics, windowDays: input.windowDays });
      const clusters: SynthesisCluster[] = [];
      const seenIds = new Set<string>();
      for (const topic of input.topics) {
        let hits: SearchHit[] = [];
        try {
          hits = await deps.memory.search(topic, {
            project: input.project,
            limit: 20,
          });
        } catch (err) {
          rethrowMemoryError(err, `gatherLearnings(${topic})`);
        }
        for (const h of hits) seenIds.add(h.id);
        clusters.push({
          topic,
          hitCount: hits.length,
          highlights: hits.slice(0, 3).map((h) => h.content),
        });
      }
      return { clusters, totalItems: seenIds.size };
    },

    /** Produces the human-readable summary. */
    async synthesize(input: {
      windowDays: number;
      clusters: SynthesisCluster[];
      totalItems: number;
    }): Promise<string> {
      log.info("synthesize", { totalItems: input.totalItems });
      return summarizer(input);
    },

    /** Captures the wall-clock time in an Activity (workflow code must stay deterministic). */
    async captureRunAt(): Promise<string> {
      return now().toISOString();
    },

    /**
     * Persists the synthesis as a Decision with confidence based on the data
     * density (more clusters with hits = more confident summary).
     */
    async persistSynthesis(input: {
      windowDays: number;
      clusters: SynthesisCluster[];
      totalItems: number;
      summary: string;
      project?: string;
      tag?: string;
    }): Promise<{ id: string | null }> {
      log.info("persistSynthesis", { totalItems: input.totalItems });
      try {
        const confidence = input.totalItems === 0
          ? 0.3
          : Math.min(0.95, 0.6 + 0.05 * input.clusters.filter((c) => c.hitCount > 0).length);
        const res = await deps.memory.decide({
          title: `Weekly memory synthesis (${input.windowDays}d, ${input.totalItems} items)`,
          decision: input.summary.slice(0, 5000),
          reasoning: `Aggregated topics: ${input.clusters.map((c) => `${c.topic}=${c.hitCount}`).join(", ")}`.slice(0, 5000),
          project: input.project,
          tags: ["t04", "memory-synthesis", input.tag ?? "weekly"],
          confidence,
        });
        return { id: res.id };
      } catch (err) {
        return rethrowMemoryError(err, "persistSynthesis");
      }
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
