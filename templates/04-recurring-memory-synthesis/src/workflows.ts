import { proxyActivities, log, ApplicationFailure } from "@temporalio/workflow";
import type { Activities } from "./activities.js";
import type { SynthesisInput, SynthesisResult } from "./shared.js";

const critical = proxyActivities<
  Pick<Activities, "gatherLearnings" | "synthesize" | "persistSynthesis" | "captureRunAt">
>({
  startToCloseTimeout: "2 minutes",
  retry: {
    initialInterval: "1s",
    maximumAttempts: 3,
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ["MemoryAuthError", "InvalidInput"],
  },
});

/**
 * T04 — Recurring Memory Synthesis Workflow.
 *
 *   captureRunAt → gatherLearnings (one search per topic, deduped) → synthesize
 *                                                                    → persistSynthesis
 *                                                                    → result
 *
 * Designed to run via Temporal Schedule (one workflow per scheduled fire) rather
 * than continueAsNew — each run is short-lived, history stays small, and Temporal
 * Schedules give us cron semantics + overlap policies + catchup windows for free.
 *
 * Use continueAsNew + entity pattern instead if you need a single long-lived
 * workflow that maintains state across runs (e.g. a counter, or a deduplication
 * cache that must survive between fires). For pure aggregate-and-write
 * synthesis, the Schedule-per-run pattern is simpler and cheaper.
 */
export async function recurringMemorySynthesisWorkflow(
  input: SynthesisInput,
): Promise<SynthesisResult> {
  if (!input.topics || input.topics.length === 0) {
    throw ApplicationFailure.create({
      message: "at least one topic is required",
      type: "InvalidInput",
      nonRetryable: true,
    });
  }
  if (!Number.isFinite(input.windowDays) || input.windowDays <= 0) {
    throw ApplicationFailure.create({
      message: "windowDays must be a positive number",
      type: "InvalidInput",
      nonRetryable: true,
    });
  }

  log.info("recurringMemorySynthesisWorkflow start", {
    windowDays: input.windowDays,
    topics: input.topics,
  });

  const runAt = await critical.captureRunAt();

  const { clusters, totalItems } = await critical.gatherLearnings(input);

  const summary = await critical.synthesize({
    windowDays: input.windowDays,
    clusters,
    totalItems,
  });

  const persisted = await critical.persistSynthesis({
    windowDays: input.windowDays,
    clusters,
    totalItems,
    summary,
    project: input.project,
    tag: input.tag,
  });

  log.info("recurringMemorySynthesisWorkflow done", {
    totalItems,
    clusters: clusters.length,
    decisionId: persisted.id,
  });

  return {
    windowDays: input.windowDays,
    clusters,
    totalItems,
    summary,
    decisionId: persisted.id,
    runAt,
  };
}
