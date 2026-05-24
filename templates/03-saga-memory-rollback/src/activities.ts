import { log, ApplicationFailure } from "@temporalio/activity";
import type { MemoryClient } from "@temporal-memory/memory-adapter";
import { MemoryClientError } from "@temporal-memory/memory-adapter";
import type {
  CompensationOutcome,
  OrderInput,
  PaymentResult,
  ReservationResult,
  ShipmentResult,
} from "./shared.js";

/** Same rethrow helper as T01/T02 — keeps Temporal retries away from auth errors. */
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
 * Pluggable order processor. Production deployments wire this to a real
 * inventory service + Stripe + shipping API; the default in-memory variant
 * lets the template run end-to-end without external services.
 *
 * IMPORTANT: every compensation MUST be idempotent. Temporal may retry an
 * activity it believes failed, and compensations themselves can run twice if
 * the worker crashes between attempts.
 */
export interface OrderProcessor {
  reserveInventory(input: OrderInput): Promise<ReservationResult>;
  chargePayment(input: OrderInput): Promise<PaymentResult>;
  createShipment(input: { order: OrderInput; paymentId: string }): Promise<ShipmentResult>;
  revertInventory(input: { order: OrderInput; reservationId: string }): Promise<void>;
  refundPayment(input: { order: OrderInput; paymentId: string }): Promise<void>;
  cancelShipment(input: { order: OrderInput; trackingNumber: string }): Promise<void>;
}

/** Default no-op processor — useful for smoke-tests without real backends. */
const defaultProcessor: OrderProcessor = {
  async reserveInventory({ orderId }) {
    return { reservationId: `res-${orderId}` };
  },
  async chargePayment({ orderId }) {
    return { paymentId: `pay-${orderId}` };
  },
  async createShipment({ order }) {
    return { trackingNumber: `track-${order.orderId}` };
  },
  async revertInventory({ reservationId }) {
    log.info("default revertInventory", { reservationId });
  },
  async refundPayment({ paymentId }) {
    log.info("default refundPayment", { paymentId });
  },
  async cancelShipment({ trackingNumber }) {
    log.info("default cancelShipment", { trackingNumber });
  },
};

export interface ActivityDeps {
  memory: MemoryClient;
  processor?: OrderProcessor;
}

export function createActivities(deps: ActivityDeps) {
  const proc = deps.processor ?? defaultProcessor;

  return {
    async reserveInventory(input: OrderInput): Promise<ReservationResult> {
      log.info("reserveInventory", { orderId: input.orderId });
      return proc.reserveInventory(input);
    },

    async chargePayment(input: OrderInput): Promise<PaymentResult> {
      log.info("chargePayment", { orderId: input.orderId });
      return proc.chargePayment(input);
    },

    async createShipment(input: { order: OrderInput; paymentId: string }): Promise<ShipmentResult> {
      log.info("createShipment", { orderId: input.order.orderId });
      return proc.createShipment(input);
    },

    async revertInventory(input: { order: OrderInput; reservationId: string }): Promise<void> {
      log.info("revertInventory", { orderId: input.order.orderId, reservationId: input.reservationId });
      return proc.revertInventory(input);
    },

    async refundPayment(input: { order: OrderInput; paymentId: string }): Promise<void> {
      log.info("refundPayment", { orderId: input.order.orderId, paymentId: input.paymentId });
      return proc.refundPayment(input);
    },

    async cancelShipment(input: { order: OrderInput; trackingNumber: string }): Promise<void> {
      log.info("cancelShipment", { orderId: input.order.orderId, trackingNumber: input.trackingNumber });
      return proc.cancelShipment(input);
    },

    /**
     * Persist a completed saga as a success learning. Critical because the
     * audit trail is the source of truth for downstream analytics.
     */
    async persistSagaSuccess(input: {
      order: OrderInput;
      reservationId: string;
      paymentId: string;
      trackingNumber: string;
    }): Promise<{ id: string | null }> {
      try {
        const res = await deps.memory.learn({
          category: "pattern",
          content: `Saga completed for order ${input.order.orderId}: reservation=${input.reservationId}, payment=${input.paymentId}, tracking=${input.trackingNumber}`,
          project: input.order.memoryProject,
          tags: ["t03", "saga-success", `order:${input.order.orderId}`],
          confidence: 0.95,
        });
        return { id: res.id };
      } catch (err) {
        return rethrowMemoryError(err, "persistSagaSuccess");
      }
    },

    /**
     * Persist a rolled-back saga as a mistake learning so future runs can
     * surface the failure mode via memory search. Stores the failed step, the
     * error, AND every compensation outcome — including any compensation that
     * itself failed (so operators know which side-effects might still be live).
     */
    async persistSagaRollback(input: {
      order: OrderInput;
      failedStep: string;
      failureReason: string;
      compensations: CompensationOutcome[];
    }): Promise<{ id: string | null }> {
      try {
        const compSummary = input.compensations
          .map((c) => `${c.name}=${c.status}${c.error ? ` (${c.error})` : ""}`)
          .join(", ");
        const failedComps = input.compensations.filter((c) => c.status === "failed");
        const body = [
          `Saga rolled back for order ${input.order.orderId}.`,
          `Failed step: ${input.failedStep}.`,
          `Reason: ${input.failureReason}.`,
          `Compensations attempted (reverse order): ${compSummary}.`,
          failedComps.length > 0
            ? `⚠️ ${failedComps.length} compensation(s) failed — manual cleanup may be required.`
            : "All compensations succeeded.",
        ].join(" ");
        const res = await deps.memory.learn({
          category: "mistake",
          content: body,
          project: input.order.memoryProject,
          tags: [
            "t03",
            "saga-rollback",
            `order:${input.order.orderId}`,
            `failed-step:${input.failedStep}`,
            ...(failedComps.length > 0 ? ["compensation-failure"] : []),
          ],
          confidence: failedComps.length > 0 ? 0.99 : 0.85,
        });
        return { id: res.id };
      } catch (err) {
        return rethrowMemoryError(err, "persistSagaRollback");
      }
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
