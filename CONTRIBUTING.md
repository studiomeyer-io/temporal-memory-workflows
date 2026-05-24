# Contributing

Thanks for considering a contribution. This repo ships durable workflow templates that combine [Temporal](https://temporal.io) with [StudioMeyer Memory](https://memory.studiomeyer.io). Every template represents the project in front of developers evaluating Temporal as a workflow engine for memory-aware AI systems, so the bar is high.

## What we accept

A new template (T06+) is a strong candidate when it:

- Solves a concrete durable-workflow problem where memory makes the difference between a stateless replay and a stateful, context-aware run.
- Demonstrates at least one meaningful Memory operation (`search`, `learn`, `entity_observe`, `entity_search`, `decide`, `synthesize`) inside an activity (never inside workflow code — see Iron Rules in the root [README](./README.md)).
- Works end-to-end against the local Dev2 cluster (`cd infrastructure/dev2 && docker compose up -d`) after the user fills `.env`.
- Has tests using `@temporalio/testing` time-skipping. No live-only tests.
- Follows the canonical T01 layout (see "Folder layout" below).

A template is **not** a good fit when it:

- Is a thin wrapper around a single Memory call without any orchestration, retries, or compensation logic.
- Requires a paid third-party service most users won't have (no free tier).
- Replicates an existing template (T01-T05) with cosmetic changes.
- Violates any of the 10 Iron Rules in the root README (e.g. non-deterministic code in workflows, side effects without activities, missing idempotency keys).

## Folder layout

Every template lives in `templates/0X-descriptive-slug/` and follows the canonical T01 skeleton:

```
templates/0X-descriptive-slug/
├── package.json             # private: true, npm workspace member
├── tsconfig.json            # extends ../../tsconfig.base.json
├── README.md                # what / why / how-to-run / extending
├── src/
│   ├── workflows.ts         # workflow code — DETERMINISTIC ONLY
│   ├── activities.ts        # activities — side effects + memory calls live here
│   ├── worker.ts            # registers workflows + activities against task queue
│   └── client.ts            # CLI subcommands: start | signal | query
└── tests/
    └── workflow.test.ts     # @temporalio/testing time-skipping
```

The number prefix matches the position in [README.md](./README.md). New templates get the next free slot (T06, T07, …).

## Using the `temporal-template` skill

If you work inside Claude Code, the global skill `temporal-template` automates the scaffold. It copies T01 as the canonical skeleton, fills the new template's name, wires the worker against the running cluster, and runs the first smoke test for you. Triggers: "neues temporal template", "T06 anlegen", "temporal worker template".

Outside Claude Code: copy `templates/01-memory-aware-agent/` to your new slot, rename everything, and follow the README structure of T01 as your reference. T01 is the golden path — read it before you write anything else.

## Code-review expectations

Every PR must pass:

1. **All Iron Rules satisfied.** Reviewers will diff your workflow code against the 10 rules. Determinism violations, missing idempotency keys, and side effects inside workflows are automatic blockers.
2. **`npm test` is green.** All 45+ tests (currently 45/45) pass with time-skipping enabled. New tests are added for new template paths — at minimum a happy-path test and one retry/timeout path.
3. **Live smoke against the local cluster.** Boot `infrastructure/dev2`, run the worker, run the client, watch the Temporal Web UI (`127.0.0.1:8233`) to confirm the workflow completes (or compensates) as expected. Paste the Workflow ID and the UI screenshot into the PR description.
4. **No `any` and no `@ts-expect-error`.** TypeScript strict mode is enforced. `npm run typecheck` must be clean.
5. **No new dependencies without a reason.** `@temporalio/*` 1.11.7 is pinned. If you need a new package, justify it in the PR.

## PR format

We use Conventional Commits. Look at recent history (`git log --oneline`) for the exact style — examples:

- `feat(T0X): add 0X-name template with memory integration`
- `fix(welle-N): correct retry policy for activity X`
- `docs(S118X): document compensation pattern in T03`
- `chore: bump @temporalio/* to 1.11.8`

Other rules:

- **One template per PR.** Don't combine T06 and T07 in the same change.
- **Branch name**: `template/0X-slug` for new templates, `fix/short-description` for bug fixes.
- **PR description** must contain: what changed, why, link to the workflow run in the local Temporal UI (Workflow ID + screenshot), and a checklist of which Iron Rules you verified.
- **Squash-merge to `main`.** Feature branches don't accumulate merge commits.

## Branch strategy

- `main` is always green and represents the latest tagged release plus any in-flight unreleased work that has passed review.
- Feature work lives on `template/0X-slug` or `fix/...` branches off `main`.
- PRs require at least one maintainer review before squash-merge.
- Tags follow semver (`v0.1.1`, `v0.2.0`). The memory-adapter package version tracks independently if and when it gets published.

## Local development

```bash
# 1. Clone + install
git clone https://github.com/studiomeyer-io/temporal-memory-workflows
cd temporal-memory-workflows
npm install
npm run build

# 2. Boot the local Temporal cluster (Postgres-backed)
cd infrastructure/dev2
cp .env.example .env       # fills sane defaults
docker compose up -d
# UI: http://127.0.0.1:8233
# Frontend: 127.0.0.1:7233

# 3. Run a template (T01 example)
cd ../../templates/01-memory-aware-agent
npm run worker             # runs in foreground, registers workflows + activities
# in another terminal:
npm run client start       # kicks off a workflow run
npm run client signal      # sends a signal to a running workflow
npm run client query       # queries workflow state

# 4. Run tests (time-skipping, no live cluster needed)
cd ../../                  # back to repo root
npm test                   # 45/45 green
```

The `infrastructure/dev2` cluster is local-only on `127.0.0.1`. It does not expose ports to the network. It uses Postgres as the persistence backend (matches the production Temporal Cloud profile more closely than the SQLite default).

## How to report bugs

Open a GitHub issue with the `bug` label. Include:

- Which template (T01-T05) and which version (`git rev-parse HEAD`).
- Node.js version (`node --version`) and OS.
- The full `WorkflowExecutionFailedError` or stack trace, if applicable.
- Repro steps: which `npm run client` command, which input payload (redact secrets).
- What you expected vs what happened.
- If the bug is reproducible against the local Dev2 cluster, paste the Workflow ID so a maintainer can replay it.

Security bugs go to `matthias10121980meyer@gmail.com` with subject `[SECURITY] temporal-memory-workflows`. See [SECURITY.md](./SECURITY.md) for details.

## How to request features

Open a GitHub issue with the `enhancement` label. We're especially interested in:

- New durable-workflow patterns that aren't covered by T01-T05 yet (continue-as-new examples, child workflows, parent-managed signals, etc.).
- Memory-adapter backends beyond the two shipped (e.g. a Redis-backed in-memory adapter for very-low-latency local dev).
- Better testing primitives — anything that makes time-skipping easier to reason about.
- Real-world failure stories that turn into a new template. If your team got bitten by a workflow non-determinism bug and the fix would help others, we want to ship it as T0N.

Feature requests should explain the problem first, not the proposed solution. "We need T06 to do X because Y" beats "implement T06 with these activities".

## Templates vs the memory-adapter package

Templates under `templates/0X-*/` are marked `private: true` in their `package.json` and are **not** intended for publish to npm. They exist as runnable reference implementations you can copy into your own project.

The `packages/memory-adapter/` package is different. It defines the `MemoryClient` interface and ships two backends (one for tests, one for production via the StudioMeyer Memory SaaS). It is currently `v0.0.1` and pre-publish, but it is structurally publishable — when we're satisfied with the interface across all 5 templates we will publish it as `@studiomeyer/memory-adapter` on npm. If you change anything in `packages/memory-adapter/`, treat it as a public-API change and document the impact in your PR.

## Tone

Be direct. Be technical. Be helpful. Disagree on substance, not on people. The full Code of Conduct lives in [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions will be licensed under the MIT License (see [LICENSE](./LICENSE)).
