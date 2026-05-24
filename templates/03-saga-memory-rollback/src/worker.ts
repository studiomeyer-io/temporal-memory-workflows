import { Worker, NativeConnection } from "@temporalio/worker";
import { HostedMemoryClient, InMemoryMemoryClient } from "@temporal-memory/memory-adapter";
import { createActivities } from "./activities.js";
import { TASK_QUEUE } from "./shared.js";

async function run() {
  const address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "memory-workflows";

  const memory =
    process.env.NEX_MEMORY_API_KEY
      ? new HostedMemoryClient({
          apiKey: process.env.NEX_MEMORY_API_KEY,
          baseUrl: process.env.NEX_MEMORY_URL,
          defaultProject: process.env.NEX_MEMORY_PROJECT ?? "temporal-memory-workflows",
        })
      : new InMemoryMemoryClient();

  if (memory instanceof InMemoryMemoryClient) {
    console.warn(
      "[worker] No NEX_MEMORY_API_KEY set — using in-memory client. Audit trail will NOT persist across worker restarts.",
    );
  }

  const connection = await NativeConnection.connect({ address });

  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue: TASK_QUEUE,
    workflowsPath: new URL("./workflows.js", import.meta.url).pathname,
    activities: createActivities({ memory }),
  });

  const shutdown = (signal: string) => {
    console.log(`[worker] ${signal} received — shutting down gracefully`);
    worker.shutdown();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));

  console.log(`[worker] connected to ${address}, namespace=${namespace}, queue=${TASK_QUEUE}`);
  await worker.run();
}

run().catch((err) => {
  console.error("[worker] fatal", err);
  process.exit(1);
});
