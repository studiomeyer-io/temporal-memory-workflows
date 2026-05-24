import { Client, Connection } from "@temporalio/client";
import { randomUUID } from "node:crypto";
import { orderSagaWorkflow } from "./workflows.js";
import { TASK_QUEUE, WORKFLOW_ID_PREFIX } from "./shared.js";
import type { OrderInput } from "./shared.js";

/**
 * Fires a sample order through the saga. Production deployments would receive
 * the OrderInput from a queue / HTTP endpoint / Stripe webhook.
 *
 *   node dist/client.js                     # uses a built-in sample order
 *   node dist/client.js cust-42 1999 EUR    # customizes customerId + amount + currency
 */
async function main() {
  const [customerArg, amountArg, currencyArg] = process.argv.slice(2);

  const address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "memory-workflows";
  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });

  const orderId = randomUUID();
  const input: OrderInput = {
    orderId,
    customerId: customerArg ?? "cust-demo",
    items: [{ sku: "DEMO-001", quantity: 1 }],
    amount: Number.parseInt(amountArg ?? "9999", 10),
    currency: currencyArg ?? "USD",
    shippingAddress: "123 Demo Street",
    memoryProject: process.env.NEX_MEMORY_PROJECT ?? "temporal-memory-workflows",
  };

  const workflowId = `${WORKFLOW_ID_PREFIX}-${orderId}`;
  console.log(`[client] starting saga workflowId=${workflowId}`);

  try {
    const handle = await client.workflow.start(orderSagaWorkflow, {
      args: [input],
      taskQueue: TASK_QUEUE,
      workflowId,
    });
    console.log(`[client] runId=${handle.firstExecutionRunId}`);
    const result = await handle.result();
    console.log("[client] result:", JSON.stringify(result, null, 2));
  } catch (err) {
    // ApplicationFailure(OrderFailed) gets surfaced here. The failure details
    // are attached to err.details — workers + UI also have the full trace.
    console.error("[client] saga failed:", err);
    process.exitCode = 1;
  } finally {
    await connection.close();
  }
}

main().catch((err) => {
  console.error("[client] fatal", err);
  process.exit(1);
});
