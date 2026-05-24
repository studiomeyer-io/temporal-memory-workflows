/**
 * Shared types + constants for T05 — Multi-Agent Coordination.
 *
 * Topology:
 *   coordinator (parent)
 *     ├── executeChild(agentTaskWorkflow) for each sub-task   ─ parallel via Promise.all
 *     │      └── each child: doAgentWork + persistAgentResult (tagged coord:<id>)
 *     └── aggregateChildResults + persistCoordination (tagged coord:<id>)
 *
 * The shared `coord:<coordinationId>` tag is the glue — querying memory for that
 * tag returns BOTH the parent synthesis AND every child's learning, in the order
 * they were persisted.
 */

export const TEMPLATE_ID = "t05-multi-agent-coordination";
export const TASK_QUEUE = TEMPLATE_ID;
export const WORKFLOW_ID_PREFIX = "t05";

export interface SubTask {
  /** Stable identifier within this coordination — used in the child workflow ID. */
  subTaskId: string;
  /** Human-readable name of the sub-task. */
  name: string;
  /** Free-form prompt / instruction passed to the child agent. */
  prompt: string;
}

export interface CoordinatorInput {
  /** Top-level identifier — used in the parent workflow ID and shared memory tag. */
  coordinationId: string;
  /** Human-readable name of the overall coordination (e.g. "research-temporal-vs-langgraph"). */
  topic: string;
  /** N sub-tasks distributed across N child workflows. Max 20 in this template. */
  subTasks: SubTask[];
  /** Optional memory project tag for scoping. */
  memoryProject?: string;
  /**
   * If true, parent waits for all children and aggregates even when some fail
   * (failures appear in the per-child result with status="failed"). If false
   * (default), parent re-throws as soon as any child fails.
   */
  tolerateChildFailures?: boolean;
}

export interface ChildAgentInput {
  /** Inherited from the parent — used in tags so siblings + parent share a coord ID. */
  coordinationId: string;
  subTaskId: string;
  name: string;
  prompt: string;
  memoryProject?: string;
}

export interface ChildAgentResult {
  subTaskId: string;
  status: "completed" | "failed";
  /** Agent's answer when completed. */
  output?: string;
  /** Error message when failed. */
  error?: string;
  /** ID of the child's persisted learning — null when memory was unavailable. */
  learningId: string | null;
}

export interface CoordinatorResult {
  coordinationId: string;
  topic: string;
  childCount: number;
  successCount: number;
  failureCount: number;
  /** Per-child results, ordered the same way as the input subTasks. */
  children: ChildAgentResult[];
  /** Aggregated summary text. */
  summary: string;
  /** Parent's persisted decision ID — null if memory was unavailable. */
  decisionId: string | null;
}

/** Maximum sub-tasks per coordination — guards against accidental fan-out explosions. */
export const MAX_SUBTASKS = 20;
