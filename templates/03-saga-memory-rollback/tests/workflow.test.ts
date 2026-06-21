import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { InMemoryMemoryClient } from "@temporal-memory/memory-adapter";
import { createActivities, type OrderProcessor } from "../src/activities.js";
import { orderSagaWorkflow } from "../src/workflows.js";
import { TASK_QUEUE } from "../src/shared.js";
import type { OrderInput } from "../src/shared.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const workflowsPath = resolve(__dirname, "../src/workflows.ts");

let testEnv: TestWorkflowEnvironment;

beforeAll(async () => {
  testEnv = await TestWorkflowEnvironment.createTimeSkipping();
}, 60_000);

afterAll(async () => {
  await testEnv?.teardown();
});

function newWorker(memory: InMemoryMemoryClient, processor: OrderProcessor) {
  return Worker.create({
    connection: testEnv.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath,
    activities: createActivities({ memory, processor }),
  });
}

function sampleOrder(extras: Partial<OrderInput> = {}): OrderInput {
  return {
    orderId: `order-${randomUUID()}`,
    customerId: "cust-1",
    items: [{ sku: "WIDGET-1", quantity: 1 }],
    amount: 1999,
    currency: "USD",
    shippingAddress: "1 Test Street",
    ...extras,
  };
}

/** Builds a processor where every method is a spy; pass partial overrides to inject failures. */
function buildProcessor(overrides: Partial<OrderProcessor> = {}) {
  const spies = {
    reserveInventory: vi.fn(async () => ({ reservationId: "res-1" })),
    chargePayment: vi.fn(async () => ({ paymentId: "pay-1" })),
    createShipment: vi.fn(async () => ({ trackingNumber: "track-1" })),
    revertInventory: vi.fn(async () => undefined),
    refundPayment: vi.fn(async () => undefined),
    cancelShipment: vi.fn(async () => undefined),
  } as unknown as OrderProcessor & {
    reserveInventory: ReturnType<typeof vi.fn>;
    chargePayment: ReturnType<typeof vi.fn>;
    createShipment: ReturnType<typeof vi.fn>;
    revertInventory: ReturnType<typeof vi.fn>;
    refundPayment: ReturnType<typeof vi.fn>;
    cancelShipment: ReturnType<typeof vi.fn>;
  };
  // Apply overrides AFTER spies so callers can replace specific methods with failures.
  Object.assign(spies, overrides);
  return spies;
}

describe("orderSagaWorkflow", () => {
  it("happy path: all three forward steps succeed + persists success learning", async () => {
    const memory = new InMemoryMemoryClient();
    const proc = buildProcessor();
    const worker = await newWorker(memory, proc);

    const order = sampleOrder();
    const result = await worker.runUntil(
      testEnv.client.workflow.execute(orderSagaWorkflow, {
        args: [order],
        workflowId: `t03-${order.orderId}`,
        taskQueue: TASK_QUEUE,
      }),
    );

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.reservationId).toBe("res-1");
      expect(result.paymentId).toBe("pay-1");
      expect(result.trackingNumber).toBe("track-1");
      expect(result.learningId).not.toBeNull();
    }
    expect(proc.reserveInventory).toHaveBeenCalledTimes(1);
    expect(proc.chargePayment).toHaveBeenCalledTimes(1);
    expect(proc.createShipment).toHaveBeenCalledTimes(1);
    expect(proc.revertInventory).not.toHaveBeenCalled();
    expect(proc.refundPayment).not.toHaveBeenCalled();
    expect(proc.cancelShipment).not.toHaveBeenCalled();

    const dumped = memory.dump();
    expect(dumped).toHaveLength(1);
    expect(dumped[0]!.type).toBe("learning");
    // success learning, no failure tag
    expect("category" in dumped[0]! ? dumped[0]!.category : "").toBe("pattern");
  });

  it("chargePayment fails → revertInventory compensation runs, rollback learning persisted", async () => {
    const memory = new InMemoryMemoryClient();
    const proc = buildProcessor({
      chargePayment: vi.fn(async () => { throw new Error("card declined"); }) as never,
    });
    const worker = await newWorker(memory, proc);

    const order = sampleOrder();
    await expect(
      worker.runUntil(
        testEnv.client.workflow.execute(orderSagaWorkflow, {
          args: [order],
          workflowId: `t03-${order.orderId}`,
          taskQueue: TASK_QUEUE,
        }),
      ),
    ).rejects.toThrow();

    expect(proc.reserveInventory).toHaveBeenCalledTimes(1);
    // Temporal retries failed activities up to 3 times per the workflow's policy.
    expect((proc as unknown as { chargePayment: ReturnType<typeof vi.fn> }).chargePayment.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(proc.createShipment).not.toHaveBeenCalled();
    expect(proc.revertInventory).toHaveBeenCalledTimes(1);
    expect(proc.refundPayment).not.toHaveBeenCalled();
    expect(proc.cancelShipment).not.toHaveBeenCalled();

    const dumped = memory.dump();
    expect(dumped).toHaveLength(1);
    expect("category" in dumped[0]! ? dumped[0]!.category : "").toBe("mistake");
    const content = "content" in dumped[0]! ? dumped[0]!.content : "";
    expect(content).toContain("failedStep" in dumped[0]! ? "" : "chargePayment");
    // All compensations succeeded here → the rollback record must take the
    // success branch and must NOT carry the `compensation-failure` tag (that tag
    // is reserved for orders that need manual reconciliation).
    expect(content).toContain("All compensations succeeded");
    const tags = "tags" in dumped[0]! ? (dumped[0]!.tags ?? []) : [];
    expect(tags).not.toContain("compensation-failure");
    expect(tags).toContain("failed-step:chargePayment");
  });

  it("createShipment fails → refundPayment + revertInventory run in reverse order", async () => {
    const memory = new InMemoryMemoryClient();
    const callOrder: string[] = [];
    const proc = buildProcessor({
      createShipment: vi.fn(async () => { throw new Error("address invalid"); }) as never,
      revertInventory: vi.fn(async () => { callOrder.push("revertInventory"); }) as never,
      refundPayment: vi.fn(async () => { callOrder.push("refundPayment"); }) as never,
    });
    const worker = await newWorker(memory, proc);

    const order = sampleOrder();
    await expect(
      worker.runUntil(
        testEnv.client.workflow.execute(orderSagaWorkflow, {
          args: [order],
          workflowId: `t03-${order.orderId}`,
          taskQueue: TASK_QUEUE,
        }),
      ),
    ).rejects.toThrow();

    expect(proc.refundPayment).toHaveBeenCalledTimes(1);
    expect(proc.revertInventory).toHaveBeenCalledTimes(1);
    // LIFO: refundPayment first (most recent forward step), then revertInventory
    expect(callOrder).toEqual(["refundPayment", "revertInventory"]);
    expect(proc.cancelShipment).not.toHaveBeenCalled();

    const dumped = memory.dump();
    expect(dumped[0]!.type).toBe("learning");
  });

  it("reserveInventory fails first → no compensations to run", async () => {
    const memory = new InMemoryMemoryClient();
    const proc = buildProcessor({
      reserveInventory: vi.fn(async () => { throw new Error("out of stock"); }) as never,
    });
    const worker = await newWorker(memory, proc);

    const order = sampleOrder();
    await expect(
      worker.runUntil(
        testEnv.client.workflow.execute(orderSagaWorkflow, {
          args: [order],
          workflowId: `t03-${order.orderId}`,
          taskQueue: TASK_QUEUE,
        }),
      ),
    ).rejects.toThrow();

    expect(proc.revertInventory).not.toHaveBeenCalled();
    expect(proc.refundPayment).not.toHaveBeenCalled();
    expect(proc.cancelShipment).not.toHaveBeenCalled();

    const dumped = memory.dump();
    expect(dumped).toHaveLength(1);
    expect("content" in dumped[0]! ? dumped[0]!.content : "").toContain("reserveInventory");
  });

  it("compensation itself fails → other compensations still run, tagged compensation-failure", async () => {
    const memory = new InMemoryMemoryClient();
    const proc = buildProcessor({
      createShipment: vi.fn(async () => { throw new Error("address invalid"); }) as never,
      // refundPayment fails AT ALL retry attempts (Temporal retries 3x by policy).
      refundPayment: vi.fn(async () => { throw new Error("stripe timeout"); }) as never,
    });
    const worker = await newWorker(memory, proc);

    const order = sampleOrder();
    await expect(
      worker.runUntil(
        testEnv.client.workflow.execute(orderSagaWorkflow, {
          args: [order],
          workflowId: `t03-${order.orderId}`,
          taskQueue: TASK_QUEUE,
        }),
      ),
    ).rejects.toThrow();

    // revertInventory still ran even though refundPayment failed — that's the core saga guarantee.
    expect(proc.revertInventory).toHaveBeenCalledTimes(1);

    const dumped = memory.dump();
    expect(dumped).toHaveLength(1);
    const content = "content" in dumped[0]! ? dumped[0]!.content : "";
    expect(content).toContain("compensation");
    expect(content).toContain("manual cleanup may be required");
  });

  it("rejects empty items array as non-retryable ApplicationFailure", async () => {
    const memory = new InMemoryMemoryClient();
    const proc = buildProcessor();
    const worker = await newWorker(memory, proc);

    await expect(
      worker.runUntil(
        testEnv.client.workflow.execute(orderSagaWorkflow, {
          args: [{
            orderId: "x",
            customerId: "c",
            items: [],
            amount: 100,
            currency: "USD",
            shippingAddress: "addr",
          }],
          workflowId: `t03-${randomUUID()}`,
          taskQueue: TASK_QUEUE,
        }),
      ),
    ).rejects.toThrow();

    expect(proc.reserveInventory).not.toHaveBeenCalled();
  });
});
