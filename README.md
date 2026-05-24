# temporal-memory-workflows

Durable [Temporal](https://temporal.io) workflow templates with [StudioMeyer Memory](https://memory.studiomeyer.io) integration. Built so AI agents and long-running pipelines have one shared brain across crashes, restarts, and weeks of execution.

> **Status:** v0.1.0 — all 5 templates live-verified against a self-hosted cluster. 45/45 tests green. Pre-npm; clone or fork to use.

## Why this exists

LangGraph is great for short LLM-centric chains. n8n is great for visual deterministic flows. Neither handles **non-LLM long-running workflows with proper durable execution semantics** — saga rollbacks, weeks of waiting on external events, retries that survive process crashes.

That's Temporal's job. This repo packages reusable templates that pair Temporal workflows with persistent agent memory, so the workflow's state (Temporal) and the agent's knowledge (Memory) stay consistent.

## Templates

| ID | Name | Status | What it shows |
|----|------|--------|---------------|
| [T01](./templates/01-memory-aware-agent/) | Memory-Aware Agent | ✅ ready | Read memory → reason → write memory, durable across worker crashes |
| [T02](./templates/02-operator-approval/) | Operator Approval | ✅ ready | `defineSignal` + `defineQuery` + `condition()` for human-in-the-loop with audit trail |
| [T03](./templates/03-saga-memory-rollback/) | Saga with Memory Rollback | ✅ ready | LIFO compensations + `mistake`-tagged memory trail for every rollback |
| [T04](./templates/04-recurring-memory-synthesis/) | Recurring Memory Synthesis | ✅ ready | Temporal Schedule API + multi-topic aggregation + LLM synthesis hook |
| [T05](./templates/05-multi-agent-coordination/) | Multi-Agent Coordination | ✅ ready | `executeChild` × N parallel + shared `coord:<id>` memory tag for full-trail queries |

## Stack

- [Temporal Server](https://temporal.io) self-hosted on Docker (Postgres-only, no Elasticsearch — minimal footprint)
- [Temporal TypeScript SDK](https://docs.temporal.io/develop/typescript) (`@temporalio/worker`, `@temporalio/client`, `@temporalio/workflow`, `@temporalio/activity`)
- [Vitest](https://vitest.dev) + [`@temporalio/testing`](https://www.npmjs.com/package/@temporalio/testing) with time-skipping
- StudioMeyer Memory — REST API via Bearer token (hosted: `memory.studiomeyer.io`)

## Layout

```
.
├── infrastructure/
│   └── dev2/                              # Docker Compose for local Temporal cluster
├── packages/
│   └── memory-adapter/                    # Nex Memory bridge (search / learn / decide)
└── templates/
    ├── 01-memory-aware-agent/             # T01 — read → reason → write
    ├── 02-operator-approval/              # T02 — signal-based HITL with timeout
    ├── 03-saga-memory-rollback/           # T03 — reserve → charge → ship + compensations
    ├── 04-recurring-memory-synthesis/     # T04 — cron-scheduled aggregation
    └── 05-multi-agent-coordination/       # T05 — parent + N children + shared tag
```

## Quick Start

```bash
# 1) Configure + start the Temporal cluster
cd infrastructure/dev2
cp .env.example .env          # fill in Postgres credentials
docker compose up -d

# 2) Install deps + build all workspaces
cd ../..
npm install
npm run build

# 3) Run tests (uses Temporal test server — no live cluster needed for unit tests)
npm test

# 4) Run T01 against the live cluster
cd templates/01-memory-aware-agent
TEMPORAL_ADDRESS=127.0.0.1:7233 \
NEX_MEMORY_URL=https://memory.studiomeyer.io \
NEX_MEMORY_API_KEY=sk_... \
npm run worker &
npm run client -- "What did we learn about Temporal yesterday?"
```

## Memory Backends

The `memory-adapter` package supports multiple backends behind the same `MemoryClient` interface:

| Backend | Status | Use case |
|---------|--------|----------|
| `HostedMemoryClient` | ✅ ready | `memory.studiomeyer.io` SaaS or any compatible REST endpoint |
| `InMemoryMemoryClient` | ✅ ready | Tests, dry runs |
| `LocalMemoryClient` | planned | Solo devs via `@studiomeyer/local-memory-mcp` (SQLite) |

Templates depend only on the interface — swap backends via DI.

## License

MIT. See [`LICENSE`](./LICENSE).

## Iron rules (carried by every template)

All five templates share the same conventions so reading one of them prepares you to read the others:

- **Workflow code is deterministic.** No `Date.now()`, `fetch`, `Math.random()`, or `process.env` inside workflow functions. All side-effects happen in activities.
- **Two `proxyActivities` buckets** per workflow — `critical` (3 attempts, `nonRetryableErrorTypes`) for must-succeed activities, `bestEffort` (1 attempt, short timeout) for fire-and-forget notifications.
- **Single source of truth** for naming in `shared.ts`: `TEMPLATE_ID`, `TASK_QUEUE`, `WORKFLOW_ID_PREFIX`. Rename in one place and everything follows.
- **Activities accept a `MemoryClient` via DI** so production swaps in `HostedMemoryClient` (REST) and tests swap in `InMemoryMemoryClient` (local mock). Same interface in both.
- **`rethrowMemoryError` helper** maps 4xx (non-429) `MemoryClientError` to `ApplicationFailure(MemoryAuthError, nonRetryable)` so Temporal short-circuits auth errors instead of burning retries.
- **Worker installs SIGTERM + SIGINT handlers** for graceful shutdown.
- **Tests use `TestWorkflowEnvironment.createTimeSkipping()`** — workflows that wait for days complete in milliseconds.
- **Optional `infrastructure/dev2/.env`** is gitignored. Never commit real Postgres credentials.

Need to add a sixth template? Follow the `/temporal-template` recipe (Claude Code skill) — same conventions, copy T01 as the skeleton.

## Related

- [StudioMeyer Memory](https://memory.studiomeyer.io) — 56-tool memory MCP for agents
- [`@studiomeyer/local-memory-mcp`](https://www.npmjs.com/package/@studiomeyer/local-memory-mcp) — SQLite local memory
- [`darwin-agents`](https://github.com/studiomeyer-io/darwin-agents) — Self-evolving agents (pairs well with Temporal reliability)
- [`n8n-templates`](https://github.com/studiomeyer-io/n8n-templates) — Visual deterministic workflows (sister repo)
