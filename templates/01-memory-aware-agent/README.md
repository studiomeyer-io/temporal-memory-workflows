# T01 — Memory-Aware Agent Workflow

Durable workflow that reads relevant memory, reasons over it, and writes a learning back. The classic agent loop, but each step survives worker crashes — Temporal replays the workflow from history.

## Flow

```
Input ── searchMemory ──► hits ── reason ──► answer ── persistLearning ──► result
                                                              │
                                                              └─ best-effort: result still returns
                                                                 if persist fails (learningId = null)
```

## Files

- `src/workflows.ts` — the deterministic workflow function
- `src/activities.ts` — `searchMemory`, `reason`, `persistLearning` — bound to a `MemoryClient` via DI
- `src/worker.ts` — boots a worker, picks `HostedMemoryClient` if `NEX_MEMORY_API_KEY` is set, else `InMemoryMemoryClient`
- `src/client.ts` — CLI that starts an execution and prints the result
- `src/shared.ts` — pure types + `TASK_QUEUE` constant (workflow-safe)
- `tests/workflow.test.ts` — full end-to-end with `@temporalio/testing` + time-skipping

## Run locally

```bash
# 1) Start the cluster (one-time per machine)
cd ../../infrastructure/dev2
docker compose up -d

# 2) From the repo root: install + build
cd ../..
npm install
npm run build

# 3) Boot a worker (terminal 1)
cd templates/01-memory-aware-agent
TEMPORAL_ADDRESS=127.0.0.1:7233 \
TEMPORAL_NAMESPACE=memory-workflows \
node --enable-source-maps dist/worker.js

# 4) Trigger an execution (terminal 2)
TEMPORAL_ADDRESS=127.0.0.1:7233 \
TEMPORAL_NAMESPACE=memory-workflows \
node --enable-source-maps dist/client.js "What did we decide about Temporal?"
```

## Plug in real memory

Set these env vars before booting the worker:

```bash
NEX_MEMORY_URL=https://memory.studiomeyer.io
NEX_MEMORY_API_KEY=sk_...
NEX_MEMORY_PROJECT=my-project   # optional default project
```

## Plug in a real LLM

`createActivities({ memory, reasoner })` accepts a `Reasoner` function. Wire it to Anthropic / OpenAI / your model of choice:

```ts
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic();
const reasoner: Reasoner = async ({ question, hits }) => {
  const memoryContext = hits.map((h) => `- ${h.content}`).join("\n");
  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 1024,
    messages: [{
      role: "user",
      content: `Memory:\n${memoryContext}\n\nQuestion: ${question}`,
    }],
  });
  return msg.content
    .filter((c): c is Anthropic.TextBlock => c.type === "text")
    .map((c) => c.text)
    .join("\n");
};

const activities = createActivities({ memory, reasoner });
```

## Tests

```bash
npm test
```

Tests use `TestWorkflowEnvironment.createTimeSkipping()` so long sleeps (e.g. retry backoffs) complete in milliseconds instead of seconds.
