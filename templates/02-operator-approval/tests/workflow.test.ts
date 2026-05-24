import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { InMemoryMemoryClient } from "@temporal-memory/memory-adapter";
import { createActivities, type Notifier, type Executor } from "../src/activities.js";
import {
  operatorApprovalWorkflow,
  approvalSignal,
  statusQuery,
} from "../src/workflows.js";
import { TASK_QUEUE } from "../src/shared.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const workflowsPath = resolve(__dirname, "../src/workflows.ts");

let testEnv: TestWorkflowEnvironment;

beforeAll(async () => {
  testEnv = await TestWorkflowEnvironment.createTimeSkipping();
}, 60_000);

afterAll(async () => {
  await testEnv?.teardown();
});

function newWorker(memory: InMemoryMemoryClient, opts: { notifier?: Notifier; executor?: Executor } = {}) {
  return Worker.create({
    connection: testEnv.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath,
    activities: createActivities({ memory, ...opts }),
  });
}

describe("operatorApprovalWorkflow", () => {
  it("returns approved + runs executor + persists decision", async () => {
    const memory = new InMemoryMemoryClient();
    const executor: Executor = vi.fn(async ({ taskId, approver }) => ({ taskId, approver, deployed: true }));
    const worker = await newWorker(memory, { executor });

    const handle = await testEnv.client.workflow.start(operatorApprovalWorkflow, {
      args: [{ taskId: "task-approved", title: "Approve me", description: "..." }],
      workflowId: `t02-${randomUUID()}`,
      taskQueue: TASK_QUEUE,
    });

    const result = await worker.runUntil(async () => {
      await handle.signal(approvalSignal, { approved: true, approver: "alice" });
      return handle.result();
    });

    expect(result.status).toBe("approved");
    expect(result.approver).toBe("alice");
    expect(result.executedResult).toMatchObject({ deployed: true });
    expect(result.decisionId).not.toBeNull();
    expect(executor).toHaveBeenCalledTimes(1);
    // Memory should contain one decision tagged approval-approved.
    expect(memory.dump()).toHaveLength(1);
  });

  it("returns rejected + does NOT run executor + persists decision", async () => {
    const memory = new InMemoryMemoryClient();
    const executor: Executor = vi.fn();
    const worker = await newWorker(memory, { executor });

    const handle = await testEnv.client.workflow.start(operatorApprovalWorkflow, {
      args: [{ taskId: "task-rejected", title: "Reject me", description: "..." }],
      workflowId: `t02-${randomUUID()}`,
      taskQueue: TASK_QUEUE,
    });

    const result = await worker.runUntil(async () => {
      await handle.signal(approvalSignal, {
        approved: false,
        approver: "bob",
        reason: "policy violation",
      });
      return handle.result();
    });

    expect(result.status).toBe("rejected");
    expect(result.approver).toBe("bob");
    expect(result.reason).toBe("policy violation");
    expect(result.executedResult).toBeUndefined();
    expect(executor).not.toHaveBeenCalled();
  });

  it("throws ApprovalTimeout when no signal arrives within the timeout", async () => {
    const memory = new InMemoryMemoryClient();
    const worker = await newWorker(memory);

    await expect(
      worker.runUntil(
        testEnv.client.workflow.execute(operatorApprovalWorkflow, {
          args: [{
            taskId: "task-timed-out",
            title: "Will time out",
            description: "no operator will signal",
            approvalTimeout: "5 seconds",
          }],
          workflowId: `t02-${randomUUID()}`,
          taskQueue: TASK_QUEUE,
        }),
      ),
    ).rejects.toThrow();

    // Persist outcome still ran — there should be a decision in memory tagged timed-out.
    const dumped = memory.dump();
    expect(dumped).toHaveLength(1);
    expect(dumped[0]!.type).toBe("decision");
  });

  it("ignores late signals after the first decision", async () => {
    const memory = new InMemoryMemoryClient();
    const worker = await newWorker(memory);

    const handle = await testEnv.client.workflow.start(operatorApprovalWorkflow, {
      args: [{ taskId: "task-late-signal", title: "first wins", description: "..." }],
      workflowId: `t02-${randomUUID()}`,
      taskQueue: TASK_QUEUE,
    });

    const result = await worker.runUntil(async () => {
      await handle.signal(approvalSignal, { approved: true, approver: "alice" });
      // Late signal — should be ignored.
      await handle.signal(approvalSignal, { approved: false, approver: "mallory" });
      return handle.result();
    });

    expect(result.status).toBe("approved");
    expect(result.approver).toBe("alice");
  });

  it("rejects empty input as non-retryable ApplicationFailure", async () => {
    const memory = new InMemoryMemoryClient();
    const worker = await newWorker(memory);

    await expect(
      worker.runUntil(
        testEnv.client.workflow.execute(operatorApprovalWorkflow, {
          args: [{ taskId: "", title: "", description: "" }],
          workflowId: `t02-${randomUUID()}`,
          taskQueue: TASK_QUEUE,
        }),
      ),
    ).rejects.toThrow();
  });

  it("status query reports awaiting before signal, then settled state after", async () => {
    const memory = new InMemoryMemoryClient();
    const worker = await newWorker(memory);

    const handle = await testEnv.client.workflow.start(operatorApprovalWorkflow, {
      args: [{ taskId: "task-query", title: "Status check", description: "..." }],
      workflowId: `t02-${randomUUID()}`,
      taskQueue: TASK_QUEUE,
    });

    const result = await worker.runUntil(async () => {
      // Allow the worker to start and reach `condition()`.
      const before = await handle.query(statusQuery);
      expect(before).toBe("awaiting");
      await handle.signal(approvalSignal, { approved: true, approver: "carol" });
      return handle.result();
    });

    expect(result.status).toBe("approved");
  });
});
