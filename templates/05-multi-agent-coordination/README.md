# T05 — Multi-Agent Coordination

Parent workflow spawns N child agent workflows in parallel via `executeChild`. Each child runs its sub-task and writes to memory with a **shared `coord:<id>` tag**. The parent aggregates the per-child results and persists a synthesis Decision — also tagged `coord:<id>` — so one `memory.search({ tag: "coord:<id>" })` returns the full trail (parent + every child).

## Topology

```
coordinator (parent)
  ├── executeChild(agentTaskWorkflow, sub-1)  ─┐
  ├── executeChild(agentTaskWorkflow, sub-2)  ─┤ Promise.all (parallel)
  ├── executeChild(agentTaskWorkflow, sub-3)  ─┘   each writes coord:<id> tag
  ├── aggregateChildResults
  └── persistCoordination (coord:<id> + coordination-result tag)
```

Each child workflow has its own event history; the parent's history only records "child started" + "child completed" events. This keeps the parent lightweight even when fanning out to 10+ children.

## Files

- `src/shared.ts` — types + constants (`SubTask`, `CoordinatorInput`, `CoordinatorResult`, `ChildAgentInput`, `MAX_SUBTASKS = 20`)
- `src/activities.ts` — `doAgentWork`, `persistAgentResult` (child), `aggregateChildResults`, `persistCoordination` (parent). `AgentWorker` DI for the actual agent logic
- `src/workflows.ts` — `agentTaskWorkflow` (child) + `multiAgentCoordinatorWorkflow` (parent). Both exported from the same module so the worker bundle resolves both
- `src/worker.ts` — registers both workflow types via a single `workflowsPath`
- `src/client.ts` — kicks off a coordination with N sample sub-tasks
- `tests/workflow.test.ts` — covers happy path, partial failure with `tolerateChildFailures=true`, fail-fast without it, input validation, child-of-child cancellation behavior

## Run locally

```bash
# 1) Cluster up (see infrastructure/dev2/README.md)
cd ../../infrastructure/dev2 && docker compose up -d

# 2) Build + boot the worker (one worker handles BOTH parent and child workflows
#    because they share the task queue)
cd ../..
npm install && npm run build
cd templates/05-multi-agent-coordination
TEMPORAL_ADDRESS=127.0.0.1:7233 \
TEMPORAL_NAMESPACE=memory-workflows \
node --enable-source-maps dist/worker.js &

# 3) Fire a coordination with 3 children
node --enable-source-maps dist/client.js "memory-pattern-research" 3

# 4) Fire a 5-child coordination that tolerates failures
T05_TOLERATE_FAILURES=1 \
node --enable-source-maps dist/client.js "wide-research" 5
```

## Plug in a real agent worker (LLM)

`createActivities({ memory, worker })` accepts an `AgentWorker` callback:

```ts
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic();
const worker: AgentWorker = async ({ name, prompt }) => {
  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 512,
    system: `You are agent "${name}". Be terse.`,
    messages: [{ role: "user", content: prompt }],
  });
  return msg.content
    .filter((c): c is Anthropic.TextBlock => c.type === "text")
    .map((c) => c.text).join("\n");
};

const activities = createActivities({ memory, worker });
```

## Shared coord tag — the glue

Every child writes:
```
[learning, category=research, tags=[t05, coord:<id>, agent:<subTaskId>]]
```

The parent writes:
```
[decision, tags=[t05, coordination-result, coord:<id>]]
```

So later you can pull the full trail with one search:
```bash
# (pseudo) — searches for everything tagged with this coordination
memory.search({ tag: "coord:<id>" })
# → returns: parent decision + N child learnings, ordered by recency
```

## Failure semantics

| `tolerateChildFailures` | Behavior |
|-------------------------|----------|
| `false` (default) | First child throw → `Promise.all` rejects → parent re-throws |
| `true` | All children complete or fail → parent collects via `Promise.allSettled` → aggregate includes failed children |

The default mirrors strict job semantics (one bad input fails the batch). Set to `true` when you want best-effort aggregation (e.g. research where some sub-questions failing is acceptable).

## Why two workflow types in one module?

`workflowsPath` points the worker at one file. Temporal's worker bundler discovers all exported workflow functions in that file. Splitting parent + child into separate modules just adds friction — both worker types need the same task queue + activity bundle anyway.

If you DO want parent + children on different workers (different task queues, different scaling profiles), pass `taskQueue` explicitly to `executeChild` and run two workers.

## Iron rules

1. **`workflowId` per child** — deterministic + namespaced under the parent (`t05-child-<coordId>-<subTaskId>`) so duplicate firing is caught by Temporal's uniqueness guarantee
2. **Children share the parent's `coord:<id>` tag** — non-negotiable for the memory query story
3. **Catch + return failed status in the child** — never let a child rejection propagate unless `tolerateChildFailures=false`
4. **`MAX_SUBTASKS = 20`** — guards against accidental fan-out explosions (10k children = parent history grows huge)
5. **One task queue for parent + children** — simpler setup; split only when you need different scaling profiles

## Tests

```bash
npm test
```

Six cases:
1. Happy path — 3 children all complete, parent aggregates + persists
2. Custom worker DI — agent gets called per child, outputs flow through
3. `tolerateChildFailures=true` — one child throws, parent completes with mixed results
4. Default (no tolerate) — one child throws, parent re-throws
5. Empty `subTasks` array → non-retryable `ApplicationFailure`
6. Exceeds `MAX_SUBTASKS` → non-retryable `ApplicationFailure`
