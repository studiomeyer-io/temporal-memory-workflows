import { Client, Connection, ScheduleOverlapPolicy } from "@temporalio/client";
import { randomUUID } from "node:crypto";
import { recurringMemorySynthesisWorkflow } from "./workflows.js";
import {
  TASK_QUEUE,
  WORKFLOW_ID_PREFIX,
  DEFAULT_SCHEDULE_ID,
  DEFAULT_CRON,
} from "./shared.js";
import type { SynthesisInput } from "./shared.js";

/**
 * CLI subcommands:
 *
 *   client.ts run               # one-shot execution (good for backfills / smoke tests)
 *   client.ts schedule-create   # creates the recurring Schedule using DEFAULT_CRON
 *   client.ts schedule-delete   # deletes the Schedule (workflows already started keep running)
 *   client.ts schedule-list     # lists current schedule IDs
 *
 * Configure topics via env:
 *   T04_TOPICS="deploy,incident,rollback"   (comma-separated, default: "pattern,mistake")
 *   T04_WINDOW_DAYS=7                       (default: 7)
 *   T04_CRON="0 21 * * 0"                   (override DEFAULT_CRON; default = Sundays 21:00 UTC)
 *   T04_SCHEDULE_ID="weekly-memory-synthesis"
 */
async function main() {
  const subcommand = process.argv[2];
  if (!subcommand) {
    printUsage();
    process.exit(2);
  }

  const address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "memory-workflows";
  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });

  const topics = (process.env.T04_TOPICS ?? "pattern,mistake")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const windowDays = Number.parseInt(process.env.T04_WINDOW_DAYS ?? "7", 10);
  const cron = process.env.T04_CRON ?? DEFAULT_CRON;
  const scheduleId = process.env.T04_SCHEDULE_ID ?? DEFAULT_SCHEDULE_ID;
  const project = process.env.NEX_MEMORY_PROJECT ?? "temporal-memory-workflows";

  const input: SynthesisInput = { windowDays, topics, project };

  try {
    if (subcommand === "run") {
      const workflowId = `${WORKFLOW_ID_PREFIX}-${randomUUID()}`;
      console.log(`[client] one-shot run workflowId=${workflowId}`);
      const handle = await client.workflow.start(recurringMemorySynthesisWorkflow, {
        args: [input],
        taskQueue: TASK_QUEUE,
        workflowId,
      });
      const result = await handle.result();
      console.log("[client] result:", JSON.stringify(result, null, 2));
    } else if (subcommand === "schedule-create") {
      const schedule = await client.schedule.create({
        scheduleId,
        action: {
          type: "startWorkflow",
          workflowType: recurringMemorySynthesisWorkflow,
          args: [input],
          taskQueue: TASK_QUEUE,
          workflowId: scheduleId,  // overridden per-fire by Temporal
        },
        spec: {
          cronExpressions: [cron],
        },
        policies: {
          // SKIP = don't queue overlapping fires (synthesis is idempotent enough
          // that a missed run is preferable to two simultaneous ones competing
          // for the same memory search budget).
          overlap: ScheduleOverlapPolicy.SKIP,
          catchupWindow: "1 day",
        },
      });
      console.log(`[client] schedule created: ${schedule.scheduleId} (cron="${cron}")`);
    } else if (subcommand === "schedule-delete") {
      const handle = client.schedule.getHandle(scheduleId);
      await handle.delete();
      console.log(`[client] schedule deleted: ${scheduleId}`);
    } else if (subcommand === "schedule-list") {
      for await (const s of client.schedule.list()) {
        console.log(s.scheduleId, JSON.stringify(s.spec ?? {}));
      }
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
  client.ts run                   one-shot workflow execution
  client.ts schedule-create       creates recurring schedule
  client.ts schedule-delete       deletes the schedule
  client.ts schedule-list         lists schedules

env:
  T04_TOPICS              comma-separated topics (default: pattern,mistake)
  T04_WINDOW_DAYS         lookback window in days (default: 7)
  T04_CRON                cron expression (default: "0 21 * * 0" = Sundays 21:00 UTC)
  T04_SCHEDULE_ID         schedule ID (default: weekly-memory-synthesis)
  NEX_MEMORY_PROJECT      project filter (default: temporal-memory-workflows)
  TEMPORAL_ADDRESS        Temporal gRPC (default: 127.0.0.1:7233)
  TEMPORAL_NAMESPACE      namespace (default: memory-workflows)`);
}

main().catch((err) => {
  console.error("[client] fatal", err);
  process.exit(1);
});
