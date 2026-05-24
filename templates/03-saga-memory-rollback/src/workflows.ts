import { proxyActivities, log, ApplicationFailure } from "@temporalio/workflow";
import type { Activities } from "./activities.js";
import type {
  CompensationOutcome,
  OrderInput,
  SagaResult,
} from "./shared.js";

// Critical-path activities — forward AND compensation steps share this policy.
// Compensations must be idempotent so 3 retries are safe; nonRetryableErrorTypes
// catches auth/validation problems that won't resolve.
const critical = proxyActivities<
  Pick<
    Activities,
    | "reserveInventory"
    | "chargePayment"
    | "createShipment"
    | "revertInventory"
    | "refundPayment"
    | "cancelShipment"
    | "persistSagaSuccess"
    | "persistSagaRollback"
  >
>({
  startToCloseTimeout: "30 seconds",
  retry: {
    initialInterval: "1s",
    maximumAttempts: 3,
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ["MemoryAuthError", "InvalidInput"],
  },
});

/**
 * T03 — Saga with Memory Rollback.
 *
 *   try {
 *     reserveInventory ──► push revertInventory compensation
 *     chargePayment    ──► push refundPayment compensation
 *     createShipment   ──► push cancelShipment compensation
 *     persistSagaSuccess
 *     return success
 *   } catch (failedStep) {
 *     for (comp of compensations.reverse()) {
 *       try { comp.run() } catch { log + collect failure }
 *     }
 *     persistSagaRollback (mistake learning with compensation outcomes)
 *     throw ApplicationFailure(OrderFailed, nonRetryable)
 *   }
 *
 * Each compensation runs independently — a failed compensation is logged + tracked
 * but does NOT short-circuit the remaining compensations (otherwise a single broken
 * refund could leave inventory permanently reserved).
 */
export async function orderSagaWorkflow(input: OrderInput): Promise<SagaResult> {
  if (!input.orderId || !input.customerId || input.items.length === 0) {
    throw ApplicationFailure.create({
      message: "orderId, customerId, and at least one item are required",
      type: "InvalidInput",
      nonRetryable: true,
    });
  }

  log.info("orderSagaWorkflow start", { orderId: input.orderId });

  /**
   * Compensation entries are pushed in forward-step order. On failure they run
   * in REVERSE order (LIFO) — the most recent forward step is undone first.
   */
  const compensations: Array<{ name: string; run: () => Promise<void> }> = [];

  let failedStep = "";
  let failureReason = "";

  try {
    // Step 1: reserve inventory
    const reservation = await critical.reserveInventory(input);
    compensations.push({
      name: "revertInventory",
      run: () => critical.revertInventory({ order: input, reservationId: reservation.reservationId }),
    });

    // Step 2: charge payment
    let payment;
    try {
      payment = await critical.chargePayment(input);
    } catch (err) {
      failedStep = "chargePayment";
      throw err;
    }
    compensations.push({
      name: "refundPayment",
      run: () => critical.refundPayment({ order: input, paymentId: payment.paymentId }),
    });

    // Step 3: create shipment
    let shipment;
    try {
      shipment = await critical.createShipment({ order: input, paymentId: payment.paymentId });
    } catch (err) {
      failedStep = "createShipment";
      throw err;
    }
    compensations.push({
      name: "cancelShipment",
      run: () => critical.cancelShipment({ order: input, trackingNumber: shipment.trackingNumber }),
    });

    // All forward steps succeeded — persist the success snapshot.
    const persisted = await critical.persistSagaSuccess({
      order: input,
      reservationId: reservation.reservationId,
      paymentId: payment.paymentId,
      trackingNumber: shipment.trackingNumber,
    });

    log.info("orderSagaWorkflow done", { orderId: input.orderId, status: "completed" });

    return {
      orderId: input.orderId,
      status: "completed",
      reservationId: reservation.reservationId,
      paymentId: payment.paymentId,
      trackingNumber: shipment.trackingNumber,
      learningId: persisted.id,
    };
  } catch (err) {
    // If failedStep was not set inside the try (e.g. reserveInventory failed first), record that.
    if (!failedStep) {
      failedStep = "reserveInventory";
    }
    failureReason = err instanceof Error ? err.message : String(err);

    log.warn("orderSagaWorkflow rolling back", {
      orderId: input.orderId,
      failedStep,
      failureReason,
      compensationsToRun: compensations.length,
    });

    const compensationResults: CompensationOutcome[] = [];
    // Reverse iteration — undo most-recent step first (LIFO).
    for (const comp of [...compensations].reverse()) {
      try {
        await comp.run();
        compensationResults.push({ name: comp.name, status: "ok" });
      } catch (compErr) {
        const message = compErr instanceof Error ? compErr.message : String(compErr);
        log.error("compensation failed; continuing with remaining compensations", {
          name: comp.name,
          error: message,
        });
        compensationResults.push({ name: comp.name, status: "failed", error: message });
        // IMPORTANT: do NOT break — every compensation gets its chance even when one fails.
      }
    }

    const persisted = await critical.persistSagaRollback({
      order: input,
      failedStep,
      failureReason,
      compensations: compensationResults,
    });

    throw ApplicationFailure.create({
      message: `Saga rolled back for order ${input.orderId}: ${failedStep} failed (${failureReason})`,
      type: "OrderFailed",
      nonRetryable: true,
      details: [{
        orderId: input.orderId,
        failedStep,
        failureReason,
        compensations: compensationResults,
        learningId: persisted.id,
      }],
    });
  }
}
