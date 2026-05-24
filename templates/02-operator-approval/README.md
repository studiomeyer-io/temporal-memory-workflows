# T02 — Operator Approval Workflow

Durable human-in-the-loop pattern. The workflow asks an operator for approval, then waits — Temporal keeps the workflow state across worker crashes, redeploys, even days of idle time. When the operator finally signals their decision, the workflow continues.

## Flow

```
Input ── searchContext ──► hits
                │
                └── notifyOperator (best-effort)
                                    │
                                    └── wait for `approval` signal | timeout
                                                  ├─ approved  ──► executeApprovedAction ──► persistOutcome ──► result
                                                  ├─ rejected  ──►                          persistOutcome ──► result
                                                  └─ timed-out ──►                          persistOutcome ──► throw ApplicationFailure(ApprovalTimeout)
```

`notifyOperator` is best-effort: a Telegram/mail outage does not block the approval flow. `executeApprovedAction` runs only when status becomes `approved`. `persistOutcome` is critical — it writes a Decision to memory so every approval has an audit trail.

## Files

- `src/workflows.ts` — the deterministic workflow function + signal/query definitions
- `src/activities.ts` — `searchContext`, `notifyOperator`, `executeApprovedAction`, `persistOutcome` — bound to a `MemoryClient`, optional `Notifier`, and optional `Executor` via DI
- `src/worker.ts` — boots a worker, picks `HostedMemoryClient` if `NEX_MEMORY_API_KEY` is set, else `InMemoryMemoryClient`. Wires SIGTERM/SIGINT to graceful shutdown
- `src/client.ts` — CLI with `start`, `status`, `approve`, `reject` subcommands
- `src/shared.ts` — pure types + constants (`TEMPLATE_ID`, `TASK_QUEUE`, `WORKFLOW_ID_PREFIX`, signal/query names)
- `tests/workflow.test.ts` — covers approval, rejection, timeout, and best-effort persist failure paths with `@temporalio/testing` time-skipping

## Run locally

```bash
# 1) Make sure the cluster + databases are up (see infrastructure/dev2/README.md)
cd ../../infrastructure/dev2
docker compose up -d

# 2) From the repo root: install + build
cd ../..
npm install
npm run build

# 3) Boot a worker (terminal 1)
cd templates/02-operator-approval
TEMPORAL_ADDRESS=127.0.0.1:7233 \
TEMPORAL_NAMESPACE=memory-workflows \
node --enable-source-maps dist/worker.js

# 4) Start a workflow (terminal 2) — copy the workflowId from the output
node --enable-source-maps dist/client.js start "Deploy new release v1.2.3"

# 5) (Optionally) check the status while it waits
node --enable-source-maps dist/client.js status t02-<uuid>

# 6) Approve or reject
node --enable-source-maps dist/client.js approve t02-<uuid> alice "looks good"
# or
node --enable-source-maps dist/client.js reject t02-<uuid> alice "needs more review"
```

## Plug in a real notifier

`createActivities({ memory, notifier, executor })` accepts pluggable callbacks. Wire them to Telegram / mail / Slack:

```ts
import type { Notifier } from "./activities.js";

const notifier: Notifier = async ({ taskId, title, description, context }) => {
  const contextSummary = context.slice(0, 3).map((h) => `- ${h.content}`).join("\n");
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: OPERATOR_CHAT_ID,
      parse_mode: "Markdown",
      text: `**Approval needed:** ${title}\n${description}\n\n_Context:_\n${contextSummary}\n\nReply with /approve ${taskId} or /reject ${taskId}.`,
    }),
  });
};

const activities = createActivities({ memory, notifier });
```

## Plug in a real executor

The executor only runs once the operator approves. The default echoes the payload; production deployments deploy infrastructure, charge cards, send mails, etc.:

```ts
const executor: Executor = async ({ taskId, payload, approver }) => {
  await deployRelease(payload?.version as string);
  return { taskId, deployedAt: new Date().toISOString(), approver };
};
```

## Tests

```bash
npm test
```

`@temporalio/testing` `createTimeSkipping()` lets the timeout test complete in milliseconds instead of seven actual days. The other tests just send signals and assert on the result.

## What this template demonstrates

- `defineSignal` + `setHandler` + `condition()` for safe human-in-the-loop
- Idempotent signal handling (late signals after a decision are ignored)
- `defineQuery` so external observers can inspect status without waiting
- Two-bucket `proxyActivities` (`critical` for must-succeed, `bestEffort` for fire-and-forget)
- Best-effort notify with try/catch swallowing inside the activity
- Memory audit trail via `nex_decide` for every outcome
- Clean timeout semantics — the workflow records the timeout to memory before throwing `ApplicationFailure(ApprovalTimeout)`
