/**
 * Shared types + constants for T02 — Operator Approval.
 * Workflow code can only import from files that are themselves deterministic.
 * Keep this file pure types + simple constants — no IO, no Date.now, no random.
 */

/** Single source of truth for the template identity. */
export const TEMPLATE_ID = "t02-operator-approval";

/**
 * Task queue is namespaced per template so multiple template workers can run against
 * the same Temporal cluster without stealing each other's tasks.
 */
export const TASK_QUEUE = TEMPLATE_ID;

/** Workflow ID prefix — keeps a recognizable name in the Temporal UI. */
export const WORKFLOW_ID_PREFIX = "t02";

/** Signal name constants — these match the strings used by `defineSignal()`. */
export const APPROVAL_SIGNAL_NAME = "approval";

/** Query name constants — match `defineQuery()`. */
export const STATUS_QUERY_NAME = "status";

export interface ApprovalRequestInput {
  /** Caller-supplied identifier — used in memory and the workflow ID. */
  taskId: string;
  /** Short title shown to the operator. */
  title: string;
  /** Longer description / context shown to the operator. */
  description: string;
  /** Arbitrary payload that the executor activity will receive when approved. */
  payload?: Record<string, unknown>;
  /** Optional project tag used to scope memory search + writes. */
  memoryProject?: string;
  /**
   * How long the workflow waits for the operator to respond. Accepts any duration
   * string Temporal understands (e.g. "7 days", "2 hours"). Defaults to "7 days".
   */
  approvalTimeout?: string;
}

export interface ApprovalSignalPayload {
  approved: boolean;
  /** Human-readable operator name — appears in the audit trail. */
  approver: string;
  /** Optional reason. Recommended for rejections. */
  reason?: string;
}

export type ApprovalStatus = "awaiting" | "approved" | "rejected" | "timed-out";

export interface ApprovalResult {
  taskId: string;
  status: ApprovalStatus;
  approver?: string;
  reason?: string;
  /** Decision ID persisted via nex_decide — null if memory backend was unavailable. */
  decisionId: string | null;
  /** Present only when status === "approved" and the executor activity ran. */
  executedResult?: unknown;
}
