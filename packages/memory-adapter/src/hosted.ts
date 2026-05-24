import type {
  DecideInput,
  LearnInput,
  MemoryClient,
  PersistResult,
  SearchHit,
  SearchOptions,
} from "./types.js";
import { MemoryClientError } from "./types.js";

export interface HostedMemoryClientOptions {
  /** Base URL of the hosted Memory REST API. Default: https://memory.studiomeyer.io */
  baseUrl?: string;
  /** Bearer token (sk_*). Required. */
  apiKey: string;
  /** Fetch implementation. Default: globalThis.fetch. Override for testing. */
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds. Default: 15000. */
  timeoutMs?: number;
  /** Optional default project tag applied when caller omits one. */
  defaultProject?: string;
}

/**
 * REST-backed memory client speaking to `memory.studiomeyer.io` or any compatible
 * deployment. Endpoints follow the public Nex Memory API surface:
 *   POST {baseUrl}/api/mcp/nex_search   { query, limit, project, types }
 *   POST {baseUrl}/api/mcp/nex_learn    { content, category, project, tags, confidence }
 *   POST {baseUrl}/api/mcp/nex_decide   { title, decision, reasoning, alternatives, project, tags, confidence }
 */
export class HostedMemoryClient implements MemoryClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly defaultProject?: string;

  constructor(options: HostedMemoryClientOptions) {
    if (!options.apiKey) {
      throw new MemoryClientError("HostedMemoryClient: apiKey is required");
    }
    this.baseUrl = (options.baseUrl ?? "https://memory.studiomeyer.io").replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.defaultProject = options.defaultProject;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    const body = {
      query,
      limit: options.limit ?? 20,
      project: options.project ?? this.defaultProject,
      types: options.types,
      recencyWeight: options.recencyWeight,
    };
    const data = await this.post<{ data?: { results?: SearchHit[] } }>("nex_search", body);
    return data.data?.results ?? [];
  }

  async learn(input: LearnInput): Promise<PersistResult> {
    const body = {
      ...input,
      project: input.project ?? this.defaultProject,
    };
    const data = await this.post<{ data?: { id?: string } }>("nex_learn", body);
    if (!data.data?.id) {
      throw new MemoryClientError("nex_learn: response missing id");
    }
    return { id: data.data.id, ok: true };
  }

  async decide(input: DecideInput): Promise<PersistResult> {
    const body = {
      ...input,
      project: input.project ?? this.defaultProject,
    };
    const data = await this.post<{ data?: { id?: string } }>("nex_decide", body);
    if (!data.data?.id) {
      throw new MemoryClientError("nex_decide: response missing id");
    }
    return { id: data.data.id, ok: true };
  }

  private async post<T>(tool: string, payload: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/mcp/${tool}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new MemoryClientError(
          `${tool} responded ${response.status}: ${text.slice(0, 200)}`,
          { status: response.status },
        );
      }
      return (await response.json()) as T;
    } catch (err) {
      if (err instanceof MemoryClientError) throw err;
      throw new MemoryClientError(`${tool} request failed`, { cause: err });
    } finally {
      clearTimeout(timeout);
    }
  }
}
