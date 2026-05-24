import { Client, Connection } from "@temporalio/client";
import { randomUUID } from "node:crypto";
import { operatorApprovalWorkflow, approvalSignal, statusQuery } from "./workflows.js";
import { TASK_QUEUE, WORKFLOW_ID_PREFIX } from "./shared.js";

/**
 * Minimal CLI:
 *
 *   node dist/client.js start "Deploy new release"
 *   node dist/client.js status t02-<uuid>
 *   node dist/client.js approve t02-<uuid> alice
 *   node dist/client.js reject  t02-<uuid> alice "needs review"
 *
 * `start` returns the workflow ID so you can hand it to a human via Telegram/mail.
 */
async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);
  if (!subcommand) {
    printUsage();
    process.exit(2);
  }

  const address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "memory-workflows";
  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });

  try {
    if (subcommand === "start") {
      const title = rest.join(" ").trim();
      if (!title) {
        console.error("usage: client.ts start <title>");
        process.exit(2);
      }
      const taskId = randomUUID();
      const workflowId = `${WORKFLOW_ID_PREFIX}-${taskId}`;
      const handle = await client.workflow.start(operatorApprovalWorkflow, {
        args: [{
          taskId,
          title,
          description: `Operator approval requested via CLI for task "${title}".`,
          memoryProject: process.env.NEX_MEMORY_PROJECT ?? "temporal-memory-workflows",
        }],
        taskQueue: TASK_QUEUE,
        workflowId,
      });
      console.log(`[client] started workflowId=${handle.workflowId}, runId=${handle.firstExecutionRunId}`);
    } else if (subcommand === "status") {
      const [workflowId] = rest;
      if (!workflowId) {
        console.error("usage: client.ts status <workflowId>");
        process.exit(2);
      }
      const status = await client.workflow.getHandle(workflowId).query(statusQuery);
      console.log(status);
    } else if (subcommand === "approve" || subcommand === "reject") {
      const [workflowId, approver, ...reasonWords] = rest;
      if (!workflowId || !approver) {
        console.error(`usage: client.ts ${subcommand} <workflowId> <approver> [reason...]`);
        process.exit(2);
      }
      await client.workflow.getHandle(workflowId).signal(approvalSignal, {
        approved: subcommand === "approve",
        approver,
        reason: reasonWords.join(" ") || undefined,
      });
      console.log(`[client] ${subcommand} signal sent to ${workflowId}`);
    } else {
      printUsage();
      process.exit(2);
    }
  } finally {
    await connection.close();
  }
}

function printUsage() {
  console.error(`usage:
  client.ts start "<title>"
  client.ts status <workflowId>
  client.ts approve <workflowId> <approver> [reason]
  client.ts reject  <workflowId> <approver> [reason]`);
}

main().catch((err) => {
  console.error("[client] fatal", err);
  process.exit(1);
});
