# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] — 2026-06-21

Correctness + fork-DX patch. No API changes; existing workflows keep their behavior.

### Fixed

- **Cross-platform worker boot (all 5 templates)** — `worker.ts` resolved `workflowsPath` via `new URL("./workflows.js", import.meta.url).pathname`. On Windows `URL.pathname` returns a drive-prefixed path (`/C:/...`) that is not a valid filesystem path, so `Worker.create()` failed to find the workflow bundle. Switched to `fileURLToPath(new URL(...))` — the same ESM-correct helper the test files already use (and the one documented in the v0.1.0 anti-patterns). Forks on Windows now boot the worker.
- **Version consistency** — all `package.json` files were `0.0.1` while the README badge said `v0.1.0` and the CI comment said `v0.1.1`. Aligned every workspace package + the README status line + the CI comment to `0.1.1`.

### Added

- **`HostedMemoryClient` coverage** — the per-request timeout / `AbortController` path is now tested (a hung backend aborts after `timeoutMs` and surfaces as a status-less `MemoryClientError`, which the activity layer treats as retryable, with the original `AbortError` preserved on `cause`). Also added `decide()` HTTP path tests (success + missing-id) and a `baseUrl` trailing-slash normalization test. Adapter suite 16 → 20 tests.
- **Saga rollback assertion** — the all-compensations-succeed rollback path now explicitly asserts the persisted `mistake` learning takes the "All compensations succeeded" branch and does **not** carry the `compensation-failure` tag (that tag stays reserved for orders needing manual reconciliation).
- **49/49 tests green** (was 45/45).

## [0.1.0] — 2026-05-24

Initial public-shape release. All five templates live-verified against a self-hosted Temporal cluster on Docker. Pre-npm; clone or fork to use.

### Added

- **Infrastructure** — `infrastructure/dev2/docker-compose.yml` boots `temporalio/auto-setup:1.28.0` + `temporalio/ui:2.40.0` against an existing Postgres (`temporal` + `temporal_visibility` DBs). gRPC on `127.0.0.1:7233`, Web UI on `127.0.0.1:8233`, ~700 MB RAM total, no Elasticsearch.
- **`@temporal-memory/memory-adapter`** — pluggable `MemoryClient` interface with three implementations:
  - `HostedMemoryClient` — REST against `memory.studiomeyer.io` or any compatible API
  - `InMemoryMemoryClient` — test/dry-run mock with naive substring search + recency scoring
  - `MemoryClientError` carrying HTTP status so activities can classify retryability
- **T01 — Memory-Aware Agent Workflow** — `searchMemory → reason → persistLearning` with two-bucket retry policies, best-effort persist, `Reasoner` DI hook for LLM wiring.
- **T02 — Operator Approval Workflow** — `defineSignal('approval')` + `defineQuery('status')` + `condition(predicate, timeout)` with 7-day default; idempotent late-signal handling; `Notifier` + `Executor` DI hooks; `ApplicationFailure(ApprovalTimeout)` on timeout with full memory trail.
- **T03 — Saga with Memory Rollback** — three-step e-commerce saga (reserve → charge → ship) with LIFO compensations that survive worker crashes; failed compensations are logged and tracked (not short-circuited); `compensation-failure` memory tag flags orders needing manual reconciliation; `OrderProcessor` DI for Stripe/inventory/shipping wiring.
- **T04 — Recurring Memory Synthesis** — Temporal Schedule API (`client.schedule.*`, not legacy `cronSchedule`) with multi-topic aggregation, hit-ID deduplication, `Summarizer` DI hook, `SKIP` overlap policy. CLI subcommands: `run`, `schedule-create`, `schedule-delete`, `schedule-list`.
- **T05 — Multi-Agent Coordination** — parent `multiAgentCoordinatorWorkflow` spawns N `agentTaskWorkflow` children via `executeChild` + `Promise.all` (or `Promise.allSettled` when `tolerateChildFailures=true`). Shared `coord:<id>` memory tag glues parent + every child for full-trail queries. `MAX_SUBTASKS=20` guard against fan-out explosions. `AgentWorker` DI for LLM-per-agent wiring.
- **45/45 tests green** with `@temporalio/testing` time-skipping — memory-adapter (12) + T01 (5) + T02 (6) + T03 (6) + T04 (6) + T05 (6) + hosted-client edge cases (4).
- **Vitest configured with `pool: "forks"`** to avoid native-binding crashes when multiple test files share the Temporal Test Server.
- **Root `tsconfig.json` solution file with project references** — adding a sixth template means appending one reference; `tsc -b` discovers everything.

### Iron rules established

These conventions are enforced across all five templates and the `/temporal-template` Claude Code skill:

1. Workflow code is deterministic; non-deterministic calls (`Date.now`, `fetch`, `Math.random`, `process.env`) happen only in activities.
2. Retry policy is explicit per activity bucket. Two buckets (`critical` + `bestEffort`) when the template has fire-and-forget side-effects (T01, T02, T05); one `critical` bucket is correct when every activity must succeed (T03 saga, T04 cron synthesis).
3. Single source of truth for naming in `shared.ts` (`TEMPLATE_ID`, `TASK_QUEUE`, `WORKFLOW_ID_PREFIX`).
4. Activities accept `MemoryClient` (and optional `Reasoner`/`Notifier`/`Executor`/`OrderProcessor`/`Summarizer`/`AgentWorker`) via DI.
5. `rethrowMemoryError` helper maps 4xx (non-429) to `ApplicationFailure(MemoryAuthError, nonRetryable)`.
6. Workers install SIGTERM + SIGINT handlers for graceful shutdown.
7. Per-template task queue (`t01-...`, `t02-...`, etc.) — never share a queue between templates.
8. Tests use `TestWorkflowEnvironment.createTimeSkipping()`.
9. `.env` files are gitignored; `.env.example` ships with placeholder values.
10. `LICENSE` (MIT) shipped at both repo root and inside `packages/memory-adapter`.

### Anti-patterns documented

Discovered during the four-wave agent-code-review loop in the same session:

- `TEMPORAL_BROADCAST_ADDRESS=<hostname>` crashes Ringpop ("malformed broadcastAddress"). Leave the env var unset; `auto-setup` finds the container's own IP.
- `require.resolve("../src/workflows")` does not work in ESM Vitest. Use `fileURLToPath(import.meta.url)` + `path.resolve`.
- Overriding `Error.cause` on a custom error class fails `noImplicitOverride: true`. Use `super(message, { cause })` with standard `ErrorOptions` instead.
- Port `8080` is commonly taken (n8n, dev servers). Map Temporal UI to `127.0.0.1:8233`.
- `options.project = ""` (empty string) must be treated as an explicit empty scope, not "no filter". Guard with `options.project != null`, not truthy check.

### Parked for future versions

These are explicitly out of scope for v0.1.0 and will be picked up later:

- `bundleWorkflowCode` for production worker containers (currently the worker bundler runs at boot; pre-bundling speeds up cold starts).
- `decide()` removal from the `MemoryClient` read interface (API-breaking; templates that only read shouldn't have to implement write).
- `rethrowMemoryError` extraction into `memory-adapter` (currently duplicated across templates; will move once we have ≥6 templates needing it).
- `LocalMemoryClient` backed by `@studiomeyer/local-memory-mcp` (SQLite stdio MCP).
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, GitHub Actions CI — to be added when this repo gets pushed to a public Git host.
