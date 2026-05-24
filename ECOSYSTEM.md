# StudioMeyer Ecosystem

`temporal-memory-workflows` is part of the StudioMeyer open source toolkit. This file maps where it sits, what it pairs well with, and what sibling repos exist if Temporal isn't the right tool for your job.

## Where this repo sits

This is the **workflow-orchestration layer** for durable, long-running, crash-resilient business processes that pair with persistent agent memory. Temporal owns the workflow state; StudioMeyer Memory owns the agent's knowledge; they stay consistent because every memory write happens inside a Temporal activity with explicit retry semantics.

If you need an LLM-centric multi-step chain with pauses → reach for LangGraph. If you need a deterministic visual pipeline non-developers can edit → reach for n8n. If you need a saga with compensations that survives a worker crash three days into a workflow → that's what this repo is for.

## MCP Server Products (Hosted)

| Product | Tools | What it does | Link |
|---------|-------|-------------|------|
| **StudioMeyer Memory** | 56 | Persistent AI memory with knowledge graph, semantic search, multi-agent support, 3D visualizations | [memory.studiomeyer.io](https://memory.studiomeyer.io) |
| **StudioMeyer CRM** | 33 | Headless CRM (contacts, companies, deals, pipeline, health scores, Stripe sync) | [crm.studiomeyer.io](https://crm.studiomeyer.io) |
| **StudioMeyer GEO** | 24 | AI visibility monitoring across 8 LLM platforms | [geo.studiomeyer.io](https://geo.studiomeyer.io) |
| **MCP Crew** | 10 | 8 expert personas with domain frameworks | [crew.studiomeyer.io](https://crew.studiomeyer.io) |

All MCP products use OAuth 2.1 + Magic Link authentication. Free tiers available. EU Frankfurt hosting.

### Why Temporal templates lean on Memory

`HostedMemoryClient` in `packages/memory-adapter` speaks the StudioMeyer Memory REST API. Every template (T01–T05) writes durable knowledge (`learn`), decisions (`decide`), and mistakes (saga rollbacks in T03) into Memory inside Temporal activities. That means:

- A workflow that crashes mid-flight, restarts on a different worker, and resumes from history will still see the same memory state — because Memory is the source of truth, not workflow-local variables.
- The memory adapter is interface-based. You can swap `HostedMemoryClient` for `InMemoryMemoryClient` (tests) or a future `LocalMemoryClient` backed by `@studiomeyer/local-memory-mcp` (solo dev, SQLite, zero cloud). Templates don't care.

**BYO or hosted:** point `NEX_MEMORY_URL` at `memory.studiomeyer.io` for the SaaS, or at any compatible REST endpoint (your own deployment of the Memory protocol).

## Sibling Repos (the full stack)

| Project | Description | Install |
|---------|-------------|---------|
| **[@studiomeyer/local-memory-mcp](https://github.com/studiomeyer-io/local-memory-mcp)** | Self-hosted SQLite-backed Memory MCP. Same interface as the hosted Memory product — swap into Temporal templates via `LocalMemoryClient` (planned). | `npm install local-memory-mcp` |
| **[darwin-agents](https://github.com/studiomeyer-io/darwin-agents)** | Self-evolving agent framework with A/B testing and safety gates. Pairs especially well with **T01** (memory-aware agent) and **T05** (multi-agent coordination) — Darwin proposes prompt variants, Temporal runs them durably, Memory persists what survives. | `npm install darwin-agents` |
| **[n8n-templates](https://github.com/studiomeyer-io/n8n-templates)** | Sister repo for **visual deterministic workflows** edited in the n8n UI. No code, no durable execution. Use when a non-developer needs to own the workflow and execution time is seconds, not days. | clone + import |
| **[n8n-nodes-studiomeyer-memory](https://github.com/studiomeyer-io/n8n-nodes-studiomeyer-memory)** | Official n8n community node for StudioMeyer Memory. Same backend as the Temporal templates here. | `npm install n8n-nodes-studiomeyer-memory` |
| **[mcp-personal-suite](https://github.com/studiomeyer-io/mcp-personal-suite)** | 49 personal-productivity MCP tools (mail, calendar, files, tasks, notes). Not directly related to Temporal — shares brand and Memory-first design. | `npx mcp-personal-suite` |
| **[mcp-armor](https://github.com/studiomeyer-io/mcp-armor)** | Defensive security sidecar that transparently wraps stdio MCP servers (prompt-injection scanner, Ed25519 manifest verify, CVE blocklist). Pair with Memory or Personal Suite when you connect untrusted MCP servers. | Rust binary |
| **[agent-fleet](https://github.com/studiomeyer-io/agent-fleet)** | Multi-agent orchestration patterns for Claude Code CLI (parallel + stateful with crash-resume). Relevant when scaling **T05** (multi-agent coordination) — Temporal handles the durable workflow layer, Agent Fleet handles the agent-spawning patterns. | clone + `npm install` |
| **[ai-shield](https://github.com/studiomeyer-io/ai-shield)** | LLM security middleware (prompt injection, PII, cost tracking, tool policies, audit logging). Wrap activities that call LLMs (the synthesis hook in T04, the agent reasoning in T01). | `npm install ai-shield-core` |

## When to use what

The orchestration-layer landscape has gotten crowded. Quick decision guide:

| Need | Use | Why |
|------|-----|-----|
| LLM-centric multi-step chain that pauses for human input mid-stream, runs in minutes | **LangGraph** | State graph + human-in-the-loop primitives, optimized for LLM token budgets and tool-calling loops. |
| Visual deterministic pipeline a non-developer can edit, runs in seconds | **n8n** | Drag-and-drop nodes, hundreds of integrations, no code path to deploy. See sister repo [`n8n-templates`](https://github.com/studiomeyer-io/n8n-templates). |
| Cloudflare-native long-running workflow (Workers + R2 + D1 stack) | **Cloudflare Workflows** | Hibernation + steps API + Workers-runtime integration. Closed ecosystem but tight if you're already on CF. |
| Production saga with compensations, signal-based human approval that may wait days, child-workflow fan-out across worker fleets, weeks of waiting on external events with full audit trail | **Temporal (this repo)** | Durable execution as a first-class primitive. Workflow state survives crashes, restarts, deploys, OS reboots. Replay from event history is the model, not an add-on. |

If your workflow is one of these, this repo is the right starting point:

- **T01 Memory-Aware Agent** — read memory → reason → write memory, durable across worker crashes
- **T02 Operator Approval** — signal + query + condition for HITL with audit trail and timeout
- **T03 Saga Memory Rollback** — reserve → charge → ship with LIFO compensations and `mistake`-tagged memory
- **T04 Recurring Memory Synthesis** — Temporal Schedule API + multi-topic aggregation + LLM synthesis hook
- **T05 Multi-Agent Coordination** — parent workflow + N child workflows + shared `coord:<id>` memory tag

## Where the templates fit

The flow we expect a builder to take:

1. They hit a Reddit post, dev.to article, or LinkedIn write-up about durable Temporal workflows with persistent memory.
2. They clone this repo, pick a template (T01–T05) that matches their job.
3. They configure `infrastructure/dev2/.env` with Postgres credentials, run `docker compose up -d`.
4. They sign up at [memory.studiomeyer.io](https://memory.studiomeyer.io) for an API key (free tier covers initial experimentation) — or swap in `LocalMemoryClient` for zero-cloud.
5. They run `npm install && npm run build && npm test` — 45 unit tests use `@temporalio/testing` time-skipping, no live cluster needed.
6. They start the worker against the local cluster, run the client, watch the workflow in the Temporal UI at `127.0.0.1:8233`.
7. Each template is independently usable. Templates depend on the `memory-adapter` package and the local `shared.ts` conventions — that's it.

## License

Every project in this ecosystem ships under [MIT](LICENSE) unless explicitly stated otherwise. Use them in commercial deployments without permission. Attribution appreciated but not required.

## Contact

- General: [hello@studiomeyer.io](mailto:hello@studiomeyer.io)
- Studio: [studiomeyer.io](https://studiomeyer.io)
- Built in Mallorca.
