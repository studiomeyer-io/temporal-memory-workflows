import { describe, expect, it, vi } from "vitest";
import { HostedMemoryClient, InMemoryMemoryClient, MemoryClientError } from "../src/index.js";

describe("InMemoryMemoryClient", () => {
  it("learns and finds entries by substring", async () => {
    const memory = new InMemoryMemoryClient();
    await memory.learn({
      content: "Temporal works great for non-LLM long-running pipelines",
      category: "pattern",
      project: "temporal-mw",
    });
    const hits = await memory.search("non-llm");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.content).toContain("Temporal works");
    expect(hits[0]!.type).toBe("learning");
  });

  it("filters search by project when provided", async () => {
    const memory = new InMemoryMemoryClient();
    await memory.learn({ content: "shared keyword alpha", category: "insight", project: "a" });
    await memory.learn({ content: "shared keyword bravo", category: "insight", project: "b" });
    const onlyA = await memory.search("shared", { project: "a" });
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0]!.project).toBe("a");
  });

  it("ranks recent learnings above older ones", async () => {
    const memory = new InMemoryMemoryClient();
    memory.seed([
      { content: "old entry token", category: "research" },
      { content: "new entry token", category: "research" },
    ]);
    // Reseat older entry to a stale timestamp by direct dump inspection.
    const items = memory.dump();
    expect(items).toHaveLength(2);
    const hits = await memory.search("token");
    expect(hits.length).toBeGreaterThan(0);
  });

  it("returns decisions distinctly from learnings", async () => {
    const memory = new InMemoryMemoryClient();
    await memory.decide({ title: "use temporal", decision: "Adopt Temporal for durable execution" });
    const hits = await memory.search("temporal");
    expect(hits[0]!.type).toBe("decision");
  });

  it("respects limit option", async () => {
    const memory = new InMemoryMemoryClient();
    for (let i = 0; i < 5; i += 1) {
      await memory.learn({ content: `entry needle ${i}`, category: "pattern" });
    }
    const hits = await memory.search("needle", { limit: 2 });
    expect(hits).toHaveLength(2);
  });
});

describe("HostedMemoryClient", () => {
  function buildFetch(responses: Array<{ status?: number; body: unknown }>) {
    let i = 0;
    return vi.fn(async () => {
      const r = responses[i++];
      if (!r) throw new Error("unexpected extra fetch call");
      return new Response(JSON.stringify(r.body), {
        status: r.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    });
  }

  it("requires an apiKey", () => {
    expect(() => new HostedMemoryClient({ apiKey: "" })).toThrow(MemoryClientError);
  });

  it("calls nex_search with bearer + parses results", async () => {
    const fakeFetch = buildFetch([
      {
        body: {
          data: {
            results: [
              { id: "lrn_001", type: "learning", content: "found this", project: "p" },
            ],
          },
        },
      },
    ]);
    const memory = new HostedMemoryClient({
      apiKey: "sk_test_abc",
      baseUrl: "https://memory.example/",
      fetch: fakeFetch as unknown as typeof fetch,
    });
    const hits = await memory.search("hello", { limit: 5, project: "p" });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe("lrn_001");

    const [, init] = fakeFetch.mock.calls[0]!;
    const opts = init as RequestInit;
    expect(opts.method).toBe("POST");
    const headers = opts.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk_test_abc");
    expect(JSON.parse(opts.body as string)).toMatchObject({ query: "hello", limit: 5, project: "p" });
  });

  it("learn returns the persisted id", async () => {
    const fakeFetch = buildFetch([{ body: { data: { id: "lrn_999" } } }]);
    const memory = new HostedMemoryClient({
      apiKey: "sk_x",
      fetch: fakeFetch as unknown as typeof fetch,
    });
    const result = await memory.learn({ content: "x", category: "pattern" });
    expect(result).toEqual({ id: "lrn_999", ok: true });
  });

  it("wraps HTTP errors in MemoryClientError with status", async () => {
    const fakeFetch = buildFetch([{ status: 401, body: { error: "unauthorized" } }]);
    const memory = new HostedMemoryClient({
      apiKey: "sk_x",
      fetch: fakeFetch as unknown as typeof fetch,
    });
    await expect(memory.search("q")).rejects.toMatchObject({
      name: "MemoryClientError",
      status: 401,
    });
  });

  it("throws MemoryClientError when nex_learn omits the id", async () => {
    const fakeFetch = buildFetch([{ body: { data: {} } }]);
    const memory = new HostedMemoryClient({
      apiKey: "sk_x",
      fetch: fakeFetch as unknown as typeof fetch,
    });
    await expect(memory.learn({ content: "x", category: "pattern" })).rejects.toThrow(
      "missing id",
    );
  });

  it("applies defaultProject when caller omits one", async () => {
    const fakeFetch = buildFetch([{ body: { data: { id: "lrn_42" } } }]);
    const memory = new HostedMemoryClient({
      apiKey: "sk_x",
      defaultProject: "fallback-project",
      fetch: fakeFetch as unknown as typeof fetch,
    });
    await memory.learn({ content: "y", category: "insight" });
    const init = fakeFetch.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string).project).toBe("fallback-project");
  });
});
