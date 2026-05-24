import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { InMemoryMemoryClient } from "@temporal-memory/memory-adapter";
import { createActivities, type Reasoner } from "../src/activities.js";
import { memoryAwareAgentWorkflow } from "../src/workflows.js";
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

function newWorker(memory: InMemoryMemoryClient, reasoner?: Reasoner) {
  return Worker.create({
    connection: testEnv.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath,
    activities: createActivities({ memory, reasoner }),
  });
}

describe("memoryAwareAgentWorkflow", () => {
  it("returns answer with memoryHits=0 when memory is empty", async () => {
    const memory = new InMemoryMemoryClient();
    const worker = await newWorker(memory);
    const result = await worker.runUntil(
      testEnv.client.workflow.execute(memoryAwareAgentWorkflow, {
        args: [{ taskId: "task-1", question: "anything novel" }],
        workflowId: `t01-${randomUUID()}`,
        taskQueue: TASK_QUEUE,
      }),
    );
    expect(result.taskId).toBe("task-1");
    expect(result.memoryHits).toBe(0);
    expect(result.answer).toContain("No prior memory");
    expect(result.learningId).not.toBeNull();
    expect(memory.dump()).toHaveLength(1);
  });

  it("returns memoryHits>0 when seeded matching learning exists", async () => {
    const memory = new InMemoryMemoryClient();
    memory.seed([
      {
        content: "Temporal is excellent for long-running pipelines",
        category: "pattern",
        project: "p",
      },
    ]);
    const worker = await newWorker(memory);
    const result = await worker.runUntil(
      testEnv.client.workflow.execute(memoryAwareAgentWorkflow, {
        args: [{ taskId: "task-2", question: "long-running pipelines", memoryProject: "p" }],
        workflowId: `t01-${randomUUID()}`,
        taskQueue: TASK_QUEUE,
      }),
    );
    expect(result.memoryHits).toBe(1);
    expect(result.answer).toContain("Found 1 memory hits");
  });

  it("uses the custom reasoner when provided", async () => {
    const memory = new InMemoryMemoryClient();
    const reasoner: Reasoner = vi.fn(async ({ question }) => `STUB(${question})`);
    const worker = await newWorker(memory, reasoner);
    const result = await worker.runUntil(
      testEnv.client.workflow.execute(memoryAwareAgentWorkflow, {
        args: [{ taskId: "task-3", question: "custom reasoner check" }],
        workflowId: `t01-${randomUUID()}`,
        taskQueue: TASK_QUEUE,
      }),
    );
    expect(result.answer).toBe("STUB(custom reasoner check)");
    expect(reasoner).toHaveBeenCalledOnce();
  });

  it("still returns answer when persist fails (learningId=null)", async () => {
    const memory = new InMemoryMemoryClient();
    // Force learn() to reject — workflow should treat persist as best-effort.
    const learnSpy = vi
      .spyOn(memory, "learn")
      .mockRejectedValue(new Error("memory backend down"));
    const worker = await newWorker(memory);
    const result = await worker.runUntil(
      testEnv.client.workflow.execute(memoryAwareAgentWorkflow, {
        args: [{ taskId: "task-4", question: "best-effort persist" }],
        workflowId: `t01-${randomUUID()}`,
        taskQueue: TASK_QUEUE,
      }),
    );
    expect(result.answer).toBeTypeOf("string");
    expect(result.learningId).toBeNull();
    expect(learnSpy).toHaveBeenCalled();
  });

  it("rejects empty input as non-retryable ApplicationFailure", async () => {
    const memory = new InMemoryMemoryClient();
    const worker = await newWorker(memory);
    await expect(
      worker.runUntil(
        testEnv.client.workflow.execute(memoryAwareAgentWorkflow, {
          args: [{ taskId: "", question: "" }],
          workflowId: `t01-${randomUUID()}`,
          taskQueue: TASK_QUEUE,
        }),
      ),
    ).rejects.toThrow();
  });
});
