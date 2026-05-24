# temporal-memory-workflows

Durable [Temporal](https://temporal.io) workflow templates with [StudioMeyer Memory](https://memory.studiomeyer.io) integration. Built so AI agents and long-running pipelines have one shared brain across crashes, restarts, and weeks of execution.

> **Status:** v0.0.1 — local dev preview. Not on npm yet. Open Source release after v0.1.0 stabilizes.

## Why this exists

LangGraph is great for short LLM-centric chains. n8n is great for visual deterministic flows. Neither handles **non-LLM long-running workflows with proper durable execution semantics** — saga rollbacks, weeks of waiting on external events, retries that survive process crashes.

That's Temporal's job. This repo packages reusable templates that pair Temporal workflows with persistent agent memory, so the workflow's state (Temporal) and the agent's knowledge (Memory) stay consistent.

## Templates (v0.1.0 roadmap)

| ID | Name | Status | What it shows |
|----|------|--------|---------------|
| T01 | Memory-Aware Agent-Workflow | **building** | Read memory → reason with LLM → write memory, durable across crashes |
| T02 | Operator-Approval with Memory Trail | planned | `interrupt()`-style HITL with audit trail in memory |
| T03 | Saga with Memory Rollback | planned | Compensation steps that record failure patterns to memory |
| T04 | Recurring Memory Synthesis | planned | Cron workflow that aggregates the week's learnings |
| T05 | Multi-Agent Coordination | planned | Squad pattern with shared durable memory |

## Stack

- [Temporal Server](https://temporal.io) self-hosted on Docker (Postgres-only, no Elasticsearch — minimal footprint)
- [Temporal TypeScript SDK](https://docs.temporal.io/develop/typescript) (`@temporalio/worker`, `@temporalio/client`, `@temporalio/workflow`, `@temporalio/activity`)
- [Vitest](https://vitest.dev) + [`@temporalio/testing`](https://www.npmjs.com/package/@temporalio/testing) with time-skipping
- StudioMeyer Memory — REST API via Bearer token (hosted: `memory.studiomeyer.io`)

## Layout

```
.
├── infrastructure/
│   └── dev2/                          # Docker Compose for local Temporal cluster
├── packages/
│   └── memory-adapter/                # Nex Memory bridge (search / learn / decide)
└── templates/
    └── 01-memory-aware-agent/         # T01 — full worker + client + tests
```

## Quick Start

```bash
# 1) Start Temporal cluster (creates DBs in existing dev2-postgres)
cd infrastructure/dev2
docker compose up -d

# 2) Install deps
cd ../..
npm install

# 3) Run tests (uses Temporal test server, no live cluster needed for unit tests)
npm test

# 4) Run T01 against live cluster
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

## Related

- [StudioMeyer Memory](https://memory.studiomeyer.io) — 56-tool memory MCP for agents
- [`@studiomeyer/local-memory-mcp`](https://www.npmjs.com/package/@studiomeyer/local-memory-mcp) — SQLite local memory
- [`darwin-agents`](https://github.com/studiomeyer-io/darwin-agents) — Self-evolving agents (pairs well with Temporal reliability)
- [`n8n-templates`](https://github.com/studiomeyer-io/n8n-templates) — Visual deterministic workflows (sister repo)
