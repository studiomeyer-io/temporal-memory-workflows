import { Client, Connection } from "@temporalio/client";
import { randomUUID } from "node:crypto";
import { multiAgentCoordinatorWorkflow } from "./workflows.js";
import { TASK_QUEUE, WORKFLOW_ID_PREFIX } from "./shared.js";
import type { CoordinatorInput, SubTask } from "./shared.js";

/**
 * Fires a coordination with three sample sub-tasks. Production deployments
 * pull sub-tasks from a queue / user input / planner-agent.
 *
 *   node dist/client.js                                  # uses 3 sample sub-tasks
 *   node dist/client.js "research-topic" 5               # custom topic + count
 */
async function main() {
  const [topicArg, countArg] = process.argv.slice(2);
  const topic = topicArg ?? "research-temporal-vs-langgraph";
  const subTaskCount = Math.max(1, Math.min(20, Number.parseInt(countArg ?? "3", 10)));

  const address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "memory-workflows";
  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });

  const coordinationId = randomUUID();
  const subTasks: SubTask[] = Array.from({ length: subTaskCount }, (_, i) => ({
    subTaskId: `sub-${i + 1}`,
    name: `Sub-task ${i + 1}`,
    prompt: `Aspect ${i + 1} of "${topic}". What stands out?`,
  }));

  const input: CoordinatorInput = {
    coordinationId,
    topic,
    subTasks,
    memoryProject: process.env.NEX_MEMORY_PROJECT ?? "temporal-memory-workflows",
    tolerateChildFailures: process.env.T05_TOLERATE_FAILURES === "1",
  };

  const workflowId = `${WORKFLOW_ID_PREFIX}-${coordinationId}`;
  console.log(`[client] starting coordinator workflowId=${workflowId} children=${subTaskCount}`);

  try {
    const handle = await client.workflow.start(multiAgentCoordinatorWorkflow, {
      args: [input],
      taskQueue: TASK_QUEUE,
      workflowId,
    });
    const result = await handle.result();
    console.log("[client] result:", JSON.stringify(result, null, 2));
  } finally {
    await connection.close();
  }
}

main().catch((err) => {
  console.error("[client] fatal", err);
  process.exit(1);
});
