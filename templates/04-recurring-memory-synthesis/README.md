# T04 — Recurring Memory Synthesis

Cron-scheduled workflow that gathers the last N days of memory across configurable topics, runs an optional LLM summarizer, and writes the synthesis back as a Decision. Uses **Temporal's Schedule API** (not legacy `cronSchedule`) for cron semantics + overlap policies + catchup windows.

## Flow

```
Schedule fires every <cron> ──► new workflow execution
                                       │
                                       ├── captureRunAt (wall-clock from activity, deterministic-safe)
                                       ├── gatherLearnings (one memory.search per topic, deduped IDs)
                                       ├── synthesize (default = counts + tag-cloud; swap in Anthropic for real LLM)
                                       └── persistSynthesis (nex_decide, confidence scaled by cluster density)
```

Each run is a fresh workflow with a small event history — no `continueAsNew` needed. The Schedule object itself is the long-lived entity Temporal manages.

## Files

- `src/shared.ts` — types + constants (`SynthesisInput`, `SynthesisResult`, `DEFAULT_CRON`, `DEFAULT_SCHEDULE_ID`)
- `src/activities.ts` — `gatherLearnings`, `synthesize`, `captureRunAt`, `persistSynthesis`. `Summarizer` DI hook so production swaps in an LLM
- `src/workflows.ts` — `recurringMemorySynthesisWorkflow` orchestrates the four steps
- `src/worker.ts` — boots a worker (same DI pattern as T01-T03)
- `src/client.ts` — CLI with `run`, `schedule-create`, `schedule-delete`, `schedule-list` subcommands
- `tests/workflow.test.ts` — covers empty-memory path, multi-topic dedup, synthesizer DI, persist failure, input validation

## Run locally

```bash
# 1) Cluster up (see infrastructure/dev2/README.md)
cd ../../infrastructure/dev2 && docker compose up -d

# 2) Build + boot the worker
cd ../..
npm install && npm run build
cd templates/04-recurring-memory-synthesis
TEMPORAL_ADDRESS=127.0.0.1:7233 \
TEMPORAL_NAMESPACE=memory-workflows \
node --enable-source-maps dist/worker.js &

# 3) One-shot run (great for smoke + backfill)
T04_TOPICS="pattern,mistake,workflow" \
T04_WINDOW_DAYS=7 \
node --enable-source-maps dist/client.js run

# 4) Create the recurring Schedule (default: Sundays 21:00 UTC)
node --enable-source-maps dist/client.js schedule-create

# 5) Inspect / delete the schedule
node --enable-source-maps dist/client.js schedule-list
node --enable-source-maps dist/client.js schedule-delete
```

## Plug in a real summarizer (LLM)

`createActivities({ memory, summarizer })` accepts a `Summarizer` callback:

```ts
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic();
const summarizer: Summarizer = async ({ windowDays, clusters, totalItems }) => {
  const context = clusters
    .filter((c) => c.hitCount > 0)
    .map((c) => `## ${c.topic} (${c.hitCount} items)\n` + c.highlights.join("\n"))
    .join("\n\n");
  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 1024,
    messages: [{
      role: "user",
      content: `Summarize this week's memory in 5 bullet points. Window: ${windowDays} days. Total items: ${totalItems}.\n\n${context}`,
    }],
  });
  return msg.content
    .filter((c): c is Anthropic.TextBlock => c.type === "text")
    .map((c) => c.text).join("\n");
};

const activities = createActivities({ memory, summarizer });
```

## Schedule vs cronSchedule

Temporal supports two cron-like mechanisms in the TypeScript SDK:

| API | Use when |
|-----|----------|
| `client.schedule.create({ spec: { cronExpressions: [...] } })` | **Modern.** Native Schedule object you can pause / inspect / list / backfill via `client.schedule.*` |
| `client.workflow.start({ cronSchedule: "* * * * *" })` | Legacy. Lives on the workflow itself, no native pause/list. Avoid for new code. |

T04 uses the modern Schedule API. The `client.ts schedule-create` subcommand wraps it.

## Why no `continueAsNew`?

`continueAsNew` matters when a single workflow execution would otherwise accumulate too much event history. T04's per-run shape — fetch, summarize, persist, return — keeps each history small. The Schedule is the long-lived state, not the workflow itself. Use `continueAsNew` if you need to maintain in-workflow state (e.g. counters, dedup caches) across fires.

## Tests

```bash
npm test
```

Six cases:
1. Empty memory → summary mentions zero items + low confidence
2. Multi-topic with overlap → dedup by hit ID, totalItems is unique count
3. Custom summarizer is called with the clusters
4. Empty topics array → non-retryable `ApplicationFailure`
5. Non-positive `windowDays` → non-retryable `ApplicationFailure`
6. `gatherLearnings` propagates a memory error correctly (auth 403 = nonRetryable)
