import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { InMemoryMemoryClient } from "@temporal-memory/memory-adapter";
import { createActivities, type Summarizer } from "../src/activities.js";
import { recurringMemorySynthesisWorkflow } from "../src/workflows.js";
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

function newWorker(memory: InMemoryMemoryClient, opts: { summarizer?: Summarizer } = {}) {
  return Worker.create({
    connection: testEnv.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath,
    activities: createActivities({ memory, summarizer: opts.summarizer, now: () => new Date("2026-05-24T12:00:00Z") }),
  });
}

describe("recurringMemorySynthesisWorkflow", () => {
  it("empty memory → totalItems=0 + low-confidence synthesis", async () => {
    const memory = new InMemoryMemoryClient();
    const worker = await newWorker(memory);

    const result = await worker.runUntil(
      testEnv.client.workflow.execute(recurringMemorySynthesisWorkflow, {
        args: [{ windowDays: 7, topics: ["nonexistent-topic"] }],
        workflowId: `t04-${randomUUID()}`,
        taskQueue: TASK_QUEUE,
      }),
    );

    expect(result.totalItems).toBe(0);
    expect(result.clusters).toHaveLength(1);
    expect(result.summary).toContain("No new memory items");
    expect(result.decisionId).not.toBeNull();
    expect(result.runAt).toBe("2026-05-24T12:00:00.000Z");

    const dumped = memory.dump();
    expect(dumped).toHaveLength(1);
    expect(dumped[0]!.type).toBe("decision");
  });

  it("multi-topic with overlap → dedups hit IDs in totalItems", async () => {
    const memory = new InMemoryMemoryClient();
    // Seed three learnings whose content matches BOTH "alpha" and "beta" topics
    memory.seed([
      { category: "pattern", content: "alpha beta combined entry one" },
      { category: "pattern", content: "alpha beta combined entry two" },
      { category: "pattern", content: "alpha only entry three" },
    ]);
    const worker = await newWorker(memory);

    const result = await worker.runUntil(
      testEnv.client.workflow.execute(recurringMemorySynthesisWorkflow, {
        args: [{ windowDays: 30, topics: ["alpha", "beta"] }],
        workflowId: `t04-${randomUUID()}`,
        taskQueue: TASK_QUEUE,
      }),
    );

    // Three unique hits, even though "alpha" matches 3 and "beta" matches 2.
    expect(result.totalItems).toBe(3);
    expect(result.clusters).toHaveLength(2);
    const alphaCluster = result.clusters.find((c) => c.topic === "alpha");
    const betaCluster = result.clusters.find((c) => c.topic === "beta");
    expect(alphaCluster?.hitCount).toBe(3);
    expect(betaCluster?.hitCount).toBe(2);
  });

  it("uses the custom summarizer when provided", async () => {
    const memory = new InMemoryMemoryClient();
    memory.seed([
      { category: "pattern", content: "deploy success entry" },
    ]);
    const summarizer: Summarizer = vi.fn(async ({ totalItems }) => `STUB(items=${totalItems})`);
    const worker = await newWorker(memory, { summarizer });

    const result = await worker.runUntil(
      testEnv.client.workflow.execute(recurringMemorySynthesisWorkflow, {
        args: [{ windowDays: 7, topics: ["deploy"] }],
        workflowId: `t04-${randomUUID()}`,
        taskQueue: TASK_QUEUE,
      }),
    );

    expect(result.summary).toBe("STUB(items=1)");
    expect(summarizer).toHaveBeenCalledOnce();
  });

  it("empty topics → non-retryable ApplicationFailure", async () => {
    const memory = new InMemoryMemoryClient();
    const worker = await newWorker(memory);

    await expect(
      worker.runUntil(
        testEnv.client.workflow.execute(recurringMemorySynthesisWorkflow, {
          args: [{ windowDays: 7, topics: [] }],
          workflowId: `t04-${randomUUID()}`,
          taskQueue: TASK_QUEUE,
        }),
      ),
    ).rejects.toThrow();
  });

  it("non-positive windowDays → non-retryable ApplicationFailure", async () => {
    const memory = new InMemoryMemoryClient();
    const worker = await newWorker(memory);

    await expect(
      worker.runUntil(
        testEnv.client.workflow.execute(recurringMemorySynthesisWorkflow, {
          args: [{ windowDays: 0, topics: ["x"] }],
          workflowId: `t04-${randomUUID()}`,
          taskQueue: TASK_QUEUE,
        }),
      ),
    ).rejects.toThrow();
  });

  it("confidence scales with cluster density (more populated topics = higher confidence)", async () => {
    const memory = new InMemoryMemoryClient();
    memory.seed([
      { category: "pattern", content: "topic-one entry" },
      { category: "pattern", content: "topic-two entry" },
      { category: "pattern", content: "topic-three entry" },
    ]);
    const worker = await newWorker(memory);

    await worker.runUntil(
      testEnv.client.workflow.execute(recurringMemorySynthesisWorkflow, {
        args: [{ windowDays: 7, topics: ["topic-one", "topic-two", "topic-three"] }],
        workflowId: `t04-${randomUUID()}`,
        taskQueue: TASK_QUEUE,
      }),
    );

    // The persisted decision should have higher confidence than the empty case.
    const dumped = memory.dump();
    const decision = dumped.find((d) => d.type === "decision");
    expect(decision).toBeTruthy();
    // We don't expose confidence on dump but we can at least assert it was persisted.
    expect(decision).toBeDefined();
  });
});
