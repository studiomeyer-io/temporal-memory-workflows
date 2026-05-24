# Security Policy

## Supported versions

This repository ships five Temporal workflow templates (T01-T05) plus a shared `memory-adapter` package. We patch security issues only on the latest minor release line.

| Version | Supported           |
| ------- | ------------------- |
| 0.1.x   | Yes (current)       |
| < 0.1   | No                  |

The `main` branch always reflects the latest supported state. Older tags exist for reproducibility but receive no patches.

## Reporting a vulnerability

If you find a security issue in any of the templates, the `memory-adapter` package, the `infrastructure/dev2` Docker Compose stack, or in how a template handles untrusted input (workflow inputs, signal payloads, query arguments, data flowing into Memory or an LLM), **do not open a public GitHub issue**.

Instead, report it privately:

- **Email:** `matthias10121980meyer@gmail.com`
- **Subject:** `[SECURITY] temporal-memory-workflows`

Please include:

1. Which template (T01-T05) or which file (e.g. `packages/memory-adapter/src/...`) is affected.
2. Reproduction steps. Workflow ID against the local Dev2 cluster is ideal. Redacted payloads for sensitive cases.
3. Why you believe it is a security issue (auth bypass, secret leak, determinism break, compensation failure, etc.).
4. Whether you would like attribution in the fix commit.
5. Your preferred timeline for coordinated disclosure (default is 90 days, see below).

## Response timeline

We do not promise a 24-hour SLA. We are a small team and these templates are not always-on production code we maintain ourselves. Realistic expectations:

- **Acknowledgement:** within 5 working days.
- **Initial assessment** (is this a security issue, what's the severity, what's the fix path): within 14 days of acknowledgement.
- **Patch landed for high-severity issues:** within 30 days of assessment, on a best-effort basis.
- **Lower-severity issues** ship in the next regular release.

If we go silent for more than 14 days without acknowledgement, please follow up — emails do get lost.

## What counts as a security issue

Things we treat as security issues:

- **Auth bypass in the `memory-adapter`.** A path that lets a workflow read or write memory for a tenant it shouldn't have access to.
- **Secret leakage through logging.** API keys, OAuth tokens, customer PII, or other secrets being written to Temporal Worker logs, Temporal Event History, Workflow Search Attributes, or downstream services in plaintext.
- **Workflow determinism violations that lead to data loss.** A non-deterministic code path that could cause a replay-time crash or a divergent execution path on history replay, resulting in lost or corrupted state. (Note: not every determinism bug is a security issue — only ones with data-loss potential.)
- **Compensation-failure bugs in T03 (Saga).** Any code path where a partial failure leaves money debited, inventory reserved, or external systems in an inconsistent state without compensation firing.
- **Untrusted-input handling in activities.** Activity inputs sourced from workflow signals or external HTTP callers that get passed unsanitized into shell commands, SQL queries, prompt strings, or filesystem paths.
- **Docker Compose stack vulnerabilities.** Default-on credentials in `infrastructure/dev2`, exposed admin ports, missing network isolation, or images with known critical CVEs at the time of the report.
- **Dependency vulnerabilities** in `@temporalio/*`, `nanoid`, `pino`, or any other runtime dependency at HIGH or CRITICAL severity, if not already patched in the latest release.

Things that are **not** security issues but are still valid bug reports (open a normal `[bug]` issue):

- Performance regressions or slow workflow execution.
- Best-practice suggestions ("you should add a child workflow for this").
- Anti-pattern corrections that don't involve data loss or unauthorized access.
- Documentation gaps or unclear README sections.
- A template that doesn't work as documented in a non-security-relevant way.
- A template that fails on a newer `@temporalio/*` SDK version because of API drift.

## Coordinated disclosure

We ask reporters to wait for a fix before publishing details. The default disclosure window is **90 days** from acknowledgement. If we have not landed a patch by then, you are free to disclose publicly. We will not retaliate against good-faith researchers who follow this policy.

If the issue is being actively exploited in the wild, please tell us up front — we may release a partial mitigation faster while a full fix is in progress.

## Defense-in-depth context

The templates in this repo flow input through several layers, each with its own security profile:

1. **Workflow client** (`templates/0X-*/src/client.ts` or an external caller). The caller is trusted to send a sane payload. Workflow inputs are persisted to Temporal's Event History.
2. **Workflow code** (`templates/0X-*/src/workflows.ts`). Deterministic only. No I/O. No environment access. No randomness without `workflow.uuid4()`. No `Date.now()` without `workflow.now()`. See the Iron Rules in the root [README](./README.md).
3. **Activities** (`templates/0X-*/src/activities.ts`). All side effects live here, including calls into the `memory-adapter`, LLM API calls, and external HTTP. Activities are where untrusted-input sanitization belongs.
4. **`memory-adapter`** (`packages/memory-adapter/`). Provides a single `MemoryClient` interface with two backends. The production backend talks to [memory.studiomeyer.io](https://memory.studiomeyer.io), which is OAuth 2.1 + multi-tenant-isolated. The in-memory backend is for tests only.
5. **Temporal Worker** (`templates/0X-*/src/worker.ts`). Registers workflows and activities against a task queue. The Worker process holds credentials (Memory API keys, LLM API keys) in environment variables — never in workflow input, never in Event History.
6. **Temporal Cluster** (`infrastructure/dev2`, or your own Temporal Cloud / self-hosted cluster). Local Dev2 cluster is `127.0.0.1`-only and uses Postgres as the persistence backend. Production deployments are the user's responsibility.

If you find a security issue in **StudioMeyer Memory itself** (not a template that uses it), report it to `matthias10121980meyer@gmail.com` with subject `[SECURITY] memory` — that gets routed to the Memory SaaS team rather than this repo's maintainers.

If you find a security issue in **Temporal itself** (the SDK or the server), report it to the [Temporal security team](https://github.com/temporalio/temporal/security/policy) directly. We will not relay third-party SDK reports.
