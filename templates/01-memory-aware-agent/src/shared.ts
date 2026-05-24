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

export const TASK_QUEUE = "memory-aware-agent";
