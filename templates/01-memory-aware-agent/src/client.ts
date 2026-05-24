import { Client, Connection } from "@temporalio/client";
import { randomUUID } from "node:crypto";
import { memoryAwareAgentWorkflow } from "./workflows.js";
import { TASK_QUEUE, WORKFLOW_ID_PREFIX } from "./shared.js";

async function main() {
  const question = process.argv.slice(2).join(" ").trim();
  if (!question) {
    console.error("usage: client.ts <question>");
    process.exit(2);
  }

  const address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "memory-workflows";

  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });

  const taskId = randomUUID();
  console.log(`[client] starting workflow taskId=${taskId}`);

  const handle = await client.workflow.start(memoryAwareAgentWorkflow, {
    args: [{
      taskId,
      question,
      memoryProject: process.env.NEX_MEMORY_PROJECT ?? "temporal-memory-workflows",
    }],
    taskQueue: TASK_QUEUE,
    workflowId: `${WORKFLOW_ID_PREFIX}-${taskId}`,
  });

  console.log(`[client] workflowId=${handle.workflowId}, runId=${handle.firstExecutionRunId}`);
  const result = await handle.result();
  console.log("[client] result:", JSON.stringify(result, null, 2));
  await connection.close();
}

main().catch((err) => {
  console.error("[client] fatal", err);
  process.exit(1);
});
