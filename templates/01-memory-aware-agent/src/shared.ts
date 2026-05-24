/**
 * Shared types used across workflow and activities.
 * Workflow code is sandboxed — it can only import from files that are themselves deterministic.
 * Keep this file pure types + simple constants.
 */

export interface AgentTaskInput {
  taskId: string;
  question: string;
  /** Optional project tag, used to scope memory search + writes. */
  memoryProject?: string;
  /** Optional bound on how many memory hits to fetch. Default 10. */
  memoryLimit?: number;
}

export interface AgentTaskResult {
  taskId: string;
  answer: string;
  memoryHits: number;
  /** Null when the persist step failed — the answer still made it out. */
  learningId: string | null;
}

/**
 * Template-wide naming prefix. Task queue, workflow ID prefix, and any other
 * identifiers stay in lockstep through this constant so renaming the template
 * never drifts across files.
 */
export const TEMPLATE_ID = "t01-memory-aware-agent";

/**
 * Task queue is namespaced per template (t01, t02, ...) to keep workers from
 * stealing tasks across templates when several run against the same cluster.
 * Future templates use `t02-...`, `t03-...`, etc.
 */
export const TASK_QUEUE = TEMPLATE_ID;

/** Workflow ID prefix — used by the client to scope IDs to this template. */
export const WORKFLOW_ID_PREFIX = "t01";
