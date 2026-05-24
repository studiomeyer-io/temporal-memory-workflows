# Pull request

## What does this PR do?

One paragraph. New template? Bug fix in an existing template? memory-adapter enhancement? Repo-wide tooling change?

## Which template(s) does it touch?

- [ ] T01 — Memory-Aware Agent
- [ ] T02 — Operator Approval
- [ ] T03 — Saga Memory Rollback
- [ ] T04 — Recurring Memory Synthesis
- [ ] T05 — Multi-Agent Coordination
- [ ] memory-adapter (`packages/memory-adapter`)
- [ ] infrastructure (`infrastructure/dev2`, docker-compose)
- [ ] repo-wide (root config, CI, docs, ECOSYSTEM.md)

## Iron Rules compliance checklist

Confirm the change respects the conventions every template carries (see README "Iron rules" section). If a box doesn't apply to this PR, explicitly mark it `n/a` in the description below.

- [ ] Workflow code stays deterministic — no `Date.now()`, `fetch`, `Math.random()`, or `process.env` inside workflow functions
- [ ] Retry policy is explicit per activity bucket (`critical` vs `bestEffort`), or single bucket if the template genuinely has only must-succeed activities
- [ ] Single source of truth in `shared.ts` (`TEMPLATE_ID`, `TASK_QUEUE`, `WORKFLOW_ID_PREFIX`) — no string literals duplicated across worker / client / workflow
- [ ] Activities accept `MemoryClient` via DI so production uses `HostedMemoryClient` and tests use `InMemoryMemoryClient`
- [ ] `rethrowMemoryError` is in place around every memory call site that can hit auth errors
- [ ] Worker installs SIGTERM + SIGINT handlers for graceful shutdown
- [ ] Tests use `TestWorkflowEnvironment.createTimeSkipping()` for any workflow that waits on time
- [ ] No real credentials, secrets, or API keys committed (`.env` stays gitignored)
- [ ] `infrastructure/dev2/.env.example` updated if a new env var was introduced
- [ ] README + ECOSYSTEM.md updated if user-visible behavior changed

## Tests passing?

```
npm install && npm run build && npm test
```

Paste the final line of the test run here (must show `N/N green`, no failures):

```
<paste output>
```

## Live-smoke against a cluster?

For workflow / activity changes, smoke-test against a real cluster (the bundled `infrastructure/dev2` docker-compose works). Paste the workflow execution-id from the Temporal UI:

- Cluster used: `127.0.0.1:7233` (local) / `<paste>`
- Memory backend used: `https://memory.studiomeyer.io` / `InMemoryMemoryClient` / `<paste>`
- Workflow execution-id: `<paste>`
- Result: completed / failed / cancelled (one line)

For doc-only or test-only changes, write `n/a (no runtime change)`.

## Linked issue

Closes #
References #

## Conventional Commit subject

The PR's merged commit message should follow Conventional Commits. Pick one prefix:

- `feat(TXX): ...` — new feature in a specific template (e.g. `feat(T03): add idempotency-key to ship activity`)
- `feat(welle-N): ...` — feature work tied to a numbered iteration wave
- `fix(TXX): ...` — bug fix in a specific template
- `fix(welle-N): ...` — fix work tied to a numbered iteration wave
- `docs(SXXXX): ...` — documentation work tied to a session number (e.g. `docs(S1183): ECOSYSTEM.md`)
- `chore(...)`, `refactor(...)`, `test(...)`, `ci(...)` — standard prefixes for the obvious cases

Paste your intended commit subject here so reviewers can confirm before merge:

```
<paste subject>
```
