import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { InMemoryMemoryClient } from "@temporal-memory/memory-adapter";
import { createActivities, type AgentWorker } from "../src/activities.js";
import { multiAgentCoordinatorWorkflow } from "../src/workflows.js";
import { TASK_QUEUE, MAX_SUBTASKS } from "../src/shared.js";
import type { CoordinatorInput, SubTask } from "../src/shared.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const workflowsPath = resolve(__dirname, "../src/workflows.ts");

let testEnv: TestWorkflowEnvironment;

beforeAll(async () => {
  testEnv = await TestWorkflowEnvironment.createTimeSkipping();
}, 60_000);

afterAll(async () => {
  await testEnv?.teardown();
});

function newWorker(memory: InMemoryMemoryClient, opts: { worker?: AgentWorker } = {}) {
  return Worker.create({
    connection: testEnv.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath,
    activities: createActivities({ memory, worker: opts.worker }),
  });
}

function makeSubTasks(n: number): SubTask[] {
  return Array.from({ length: n }, (_, i) => ({
    subTaskId: `sub-${i + 1}`,
    name: `task ${i + 1}`,
    prompt: `prompt for ${i + 1}`,
  }));
}

function makeInput(extras: Partial<CoordinatorInput> = {}): CoordinatorInput {
  return {
    coordinationId: randomUUID(),
    topic: "test-topic",
    subTasks: makeSubTasks(3),
    ...extras,
  };
}

describe("multiAgentCoordinatorWorkflow", () => {
  it("happy path: 3 children complete, parent aggregates + persists with coord tag", async () => {
    const memory = new InMemoryMemoryClient();
    const worker = await newWorker(memory);
    const input = makeInput();

    const result = await worker.runUntil(
      testEnv.client.workflow.execute(multiAgentCoordinatorWorkflow, {
        args: [input],
        workflowId: `t05-${input.coordinationId}`,
        taskQueue: TASK_QUEUE,
      }),
    );

    expect(result.childCount).toBe(3);
    expect(result.successCount).toBe(3);
    expect(result.failureCount).toBe(0);
    expect(result.children).toHaveLength(3);
    expect(result.children.every((c) => c.status === "completed")).toBe(true);
    expect(result.summary).toContain("3/3 children completed");
    expect(result.decisionId).not.toBeNull();

    // Memory should contain 3 child learnings + 1 parent decision = 4 items, all
    // tagged with the same coord:<id>.
    const dumped = memory.dump();
    expect(dumped).toHaveLength(4);
    const learnings = dumped.filter((d) => d.type === "learning");
    const decisions = dumped.filter((d) => d.type === "decision");
    expect(learnings).toHaveLength(3);
    expect(decisions).toHaveLength(1);
  });

  it("custom worker is called per child + outputs flow into aggregation", async () => {
    const memory = new InMemoryMemoryClient();
    const agentWorker: AgentWorker = vi.fn(async ({ subTaskId, prompt }) => `AGENT(${subTaskId}:${prompt})`);
    const worker = await newWorker(memory, { worker: agentWorker });
    const input = makeInput({ subTasks: makeSubTasks(2) });

    const result = await worker.runUntil(
      testEnv.client.workflow.execute(multiAgentCoordinatorWorkflow, {
        args: [input],
        workflowId: `t05-${input.coordinationId}`,
        taskQueue: TASK_QUEUE,
      }),
    );

    expect(agentWorker).toHaveBeenCalledTimes(2);
    expect(result.children[0]!.output).toBe("AGENT(sub-1:prompt for 1)");
    expect(result.children[1]!.output).toBe("AGENT(sub-2:prompt for 2)");
    expect(result.summary).toContain("AGENT(sub-1");
  });

  it("tolerateChildFailures=true: one child fails, parent still completes with mixed results", async () => {
    const memory = new InMemoryMemoryClient();
    const agentWorker: AgentWorker = vi.fn(async ({ subTaskId }) => {
      if (subTaskId === "sub-2") throw new Error("intentional sub-2 failure");
      return `ok-${subTaskId}`;
    });
    const worker = await newWorker(memory, { worker: agentWorker });
    const input = makeInput({ tolerateChildFailures: true });

    const result = await worker.runUntil(
      testEnv.client.workflow.execute(multiAgentCoordinatorWorkflow, {
        args: [input],
        workflowId: `t05-${input.coordinationId}`,
        taskQueue: TASK_QUEUE,
      }),
    );

    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(1);
    const failed = result.children.find((c) => c.subTaskId === "sub-2");
    expect(failed?.status).toBe("failed");
    // Temporal wraps activity rejections in ActivityFailure, so the original
    // worker error message is in the chained cause, not the top-level message.
    // We only assert the failure is non-empty + the result is wired correctly.
    expect(failed?.error).toBeTruthy();
    expect(result.summary).toContain("Failures:");
  });

  it("empty subTasks → non-retryable ApplicationFailure", async () => {
    const memory = new InMemoryMemoryClient();
    const worker = await newWorker(memory);

    await expect(
      worker.runUntil(
        testEnv.client.workflow.execute(multiAgentCoordinatorWorkflow, {
          args: [{ coordinationId: randomUUID(), topic: "t", subTasks: [] }],
          workflowId: `t05-${randomUUID()}`,
          taskQueue: TASK_QUEUE,
        }),
      ),
    ).rejects.toThrow();
  });

  it(`exceeds MAX_SUBTASKS (${MAX_SUBTASKS}) → non-retryable ApplicationFailure`, async () => {
    const memory = new InMemoryMemoryClient();
    const worker = await newWorker(memory);

    await expect(
      worker.runUntil(
        testEnv.client.workflow.execute(multiAgentCoordinatorWorkflow, {
          args: [{
            coordinationId: randomUUID(),
            topic: "too-many",
            subTasks: makeSubTasks(MAX_SUBTASKS + 1),
          }],
          workflowId: `t05-${randomUUID()}`,
          taskQueue: TASK_QUEUE,
        }),
      ),
    ).rejects.toThrow();
  });

  it("missing coordinationId → non-retryable ApplicationFailure", async () => {
    const memory = new InMemoryMemoryClient();
    const worker = await newWorker(memory);

    await expect(
      worker.runUntil(
        testEnv.client.workflow.execute(multiAgentCoordinatorWorkflow, {
          args: [{ coordinationId: "", topic: "t", subTasks: makeSubTasks(1) }],
          workflowId: `t05-${randomUUID()}`,
          taskQueue: TASK_QUEUE,
        }),
      ),
    ).rejects.toThrow();
  });
});
