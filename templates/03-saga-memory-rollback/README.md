# T03 — Saga with Memory Rollback

Classic three-step saga pattern (reserve → charge → ship) with reverse-order compensations. Every failed step writes a `nex_learn(category="mistake")` entry to memory so future runs can surface the failure mode by searching past learnings.

## Flow

```
try {
  reserveInventory ──► push revertInventory compensation
  chargePayment    ──► push refundPayment compensation
  createShipment   ──► push cancelShipment compensation
  persistSagaSuccess (success learning)
  return { status: "completed", ... }
} catch (failedStep) {
  for (comp of compensations.reverse()) {
    try { comp.run() } catch { log + collect failure outcome }
  }
  persistSagaRollback (mistake learning + every compensation result)
  throw ApplicationFailure(OrderFailed, nonRetryable)
}
```

A **failed compensation** is logged and recorded but does NOT short-circuit the remaining compensations — otherwise a single broken refund could leave inventory permanently reserved.

## Files

- `src/shared.ts` — types + constants (`OrderInput`, `SagaResult`, `TEMPLATE_ID`, `TASK_QUEUE`, `WORKFLOW_ID_PREFIX`)
- `src/activities.ts` — forward steps + compensations + two persist activities (success / rollback). `OrderProcessor` interface injected via DI so tests can mock backends
- `src/workflows.ts` — `orderSagaWorkflow` with compensation collection + reverse-order rollback + per-compensation error isolation
- `src/worker.ts` / `src/client.ts` — boot a worker, fire a sample order
- `tests/workflow.test.ts` — covers happy path, failure at each of the three steps, and a compensation that itself fails

## Run locally

```bash
# 1) Make sure the cluster is up (see infrastructure/dev2/README.md)
cd ../../infrastructure/dev2 && docker compose up -d

# 2) Build + boot the worker
cd ../..
npm install && npm run build
cd templates/03-saga-memory-rollback
TEMPORAL_ADDRESS=127.0.0.1:7233 \
TEMPORAL_NAMESPACE=memory-workflows \
node --enable-source-maps dist/worker.js &

# 3) Fire a sample order
TEMPORAL_ADDRESS=127.0.0.1:7233 \
TEMPORAL_NAMESPACE=memory-workflows \
node --enable-source-maps dist/client.js
```

## Plug in real backends

`createActivities({ memory, processor })` accepts an `OrderProcessor` interface. Production deployments implement it against Stripe, your inventory service, and your shipping API:

```ts
const processor: OrderProcessor = {
  async reserveInventory(order) {
    const reservation = await inventory.reserve(order.items);
    return { reservationId: reservation.id };
  },
  async chargePayment(order) {
    const charge = await stripe.charges.create({
      amount: order.amount,
      currency: order.currency,
      customer: order.customerId,
      idempotency_key: `charge-${order.orderId}`,        // MUST be idempotent
    });
    return { paymentId: charge.id };
  },
  async createShipment({ order, paymentId }) {
    const shipment = await shippo.shipments.create({
      reference: `ship-${order.orderId}`,                // idempotency key
      address: order.shippingAddress,
      metadata: { paymentId },
    });
    return { trackingNumber: shipment.tracking };
  },

  // Compensations — must ALL be idempotent.
  async revertInventory({ reservationId }) {
    await inventory.release(reservationId);
  },
  async refundPayment({ paymentId }) {
    await stripe.refunds.create({
      charge: paymentId,
      idempotency_key: `refund-${paymentId}`,            // MUST be idempotent
    });
  },
  async cancelShipment({ trackingNumber }) {
    await shippo.shipments.cancel(trackingNumber);
  },
};
```

## Iron rule: compensations MUST be idempotent

Temporal retries activities it believes failed. If the network blip ate your "ok" response while the refund had already gone through, a retry will hit Stripe again. Use idempotency keys derived from a stable input (`order.orderId`, `paymentId`) so the second call is a no-op.

## Memory trail shape

**Success:**
```
[learning, category=pattern, tags=[t03, saga-success, order:<id>], confidence=0.95]
Saga completed for order <id>: reservation=res-xxx, payment=pay-yyy, tracking=track-zzz
```

**Rollback (all compensations OK):**
```
[learning, category=mistake, tags=[t03, saga-rollback, order:<id>, failed-step:chargePayment], confidence=0.85]
Saga rolled back for order <id>. Failed step: chargePayment. Reason: card declined.
Compensations attempted (reverse order): revertInventory=ok. All compensations succeeded.
```

**Rollback (compensation failure):**
```
[learning, category=mistake, tags=[t03, saga-rollback, order:<id>, failed-step:createShipment, compensation-failure], confidence=0.99]
Saga rolled back for order <id>. Failed step: createShipment. Reason: address invalid.
Compensations attempted (reverse order): refundPayment=failed (stripe timeout), revertInventory=ok.
⚠️ 1 compensation(s) failed — manual cleanup may be required.
```

The `compensation-failure` tag is the operational signal — search memory for it to find orders that need manual reconciliation.

## Tests

```bash
npm test
```

Five cases verify:
1. Happy path — all three forward steps succeed, success learning persisted
2. `chargePayment` fails — `revertInventory` compensation runs, mistake learning persisted
3. `createShipment` fails — `refundPayment` + `revertInventory` run in reverse order
4. `reserveInventory` fails first — no compensations to run, mistake learning records `failed-step: reserveInventory`
5. Compensation itself fails — other compensations still run, learning tagged `compensation-failure`
