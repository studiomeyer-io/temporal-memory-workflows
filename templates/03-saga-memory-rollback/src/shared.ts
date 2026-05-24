/**
 * Shared types + constants for T03 — Saga with Memory Rollback.
 * The saga uses the classic three-step e-commerce example (reserve, charge, ship)
 * because it maps cleanly onto Stripe-lifecycle and other real production sagas.
 * Pure types + constants only — workflow code must import deterministically.
 */

export const TEMPLATE_ID = "t03-saga-memory-rollback";
export const TASK_QUEUE = TEMPLATE_ID;
export const WORKFLOW_ID_PREFIX = "t03";

export interface OrderInput {
  orderId: string;
  customerId: string;
  /** Items to reserve from inventory. */
  items: Array<{ sku: string; quantity: number }>;
  /** Amount in the smallest currency unit (cents). */
  amount: number;
  currency: string;
  /** Shipping address (free-form for the template). */
  shippingAddress: string;
  /** Optional project tag for memory scoping. */
  memoryProject?: string;
}

export interface ReservationResult {
  reservationId: string;
}

export interface PaymentResult {
  paymentId: string;
}

export interface ShipmentResult {
  trackingNumber: string;
}

export interface CompensationOutcome {
  /** Activity name (revertInventory / refundPayment / cancelShipment). */
  name: string;
  /** ok = compensation ran cleanly. failed = compensation itself threw. */
  status: "ok" | "failed";
  /** Optional error message when the compensation itself failed. */
  error?: string;
}

export interface SagaSuccessResult {
  orderId: string;
  status: "completed";
  reservationId: string;
  paymentId: string;
  trackingNumber: string;
  /** Memory learning ID for the success snapshot — null if memory was unavailable. */
  learningId: string | null;
}

export interface SagaRolledBackResult {
  orderId: string;
  status: "rolled-back";
  /** The step that failed (reserveInventory / chargePayment / createShipment). */
  failedStep: string;
  /** Stringified error from the failed step. */
  failureReason: string;
  /** Order of compensations actually attempted (reverse insertion order). */
  compensations: CompensationOutcome[];
  /** Memory learning ID for the rollback trail — null if memory was unavailable. */
  learningId: string | null;
}

export type SagaResult = SagaSuccessResult | SagaRolledBackResult;
