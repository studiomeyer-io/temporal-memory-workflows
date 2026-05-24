/**
 * Shared types + constants for T04 — Recurring Memory Synthesis.
 * Workflow runs on a Temporal Schedule (cron-like). Each execution gathers the
 * last N days of memory, synthesizes a summary, and writes the synthesis back
 * as a decision so future runs can build on it.
 */

export const TEMPLATE_ID = "t04-recurring-memory-synthesis";
export const TASK_QUEUE = TEMPLATE_ID;
export const WORKFLOW_ID_PREFIX = "t04";

/** Default schedule ID — one-per-tenant; deletes via client.schedule.delete. */
export const DEFAULT_SCHEDULE_ID = "weekly-memory-synthesis";

/** Default cron: Sundays at 21:00 UTC. Override via env or CLI. */
export const DEFAULT_CRON = "0 21 * * 0";

export interface SynthesisInput {
  /** Number of days of memory to aggregate. */
  windowDays: number;
  /** Optional project filter — if set, restricts memory search to that project. */
  project?: string;
  /**
   * Topic / theme keywords used to seed the memory search. The workflow runs one
   * search per topic and merges results — useful when the synthesizer should
   * focus on specific areas (e.g. ["deploy", "incident", "rollback"]).
   */
  topics: string[];
  /** Tag applied to the persisted synthesis decision. */
  tag?: string;
}

export interface SynthesisCluster {
  topic: string;
  hitCount: number;
  /** Top items by rank — limited to keep the summary readable. */
  highlights: string[];
}

export interface SynthesisResult {
  windowDays: number;
  /** Aggregated per-topic counts + highlights. */
  clusters: SynthesisCluster[];
  /** Total unique items across all topics. */
  totalItems: number;
  /** Human-readable summary produced by the synthesizer. */
  summary: string;
  /** Decision ID persisted via nex_decide — null if memory was unavailable. */
  decisionId: string | null;
  /** ISO timestamp captured by an activity (deterministic-safe). */
  runAt: string;
}
