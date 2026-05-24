import type {
  DecideInput,
  LearnInput,
  MemoryClient,
  PersistResult,
  SearchHit,
  SearchOptions,
} from "./types.js";

interface StoredLearning extends LearnInput {
  id: string;
  type: "learning";
  createdAt: number;
}

interface StoredDecision extends DecideInput {
  id: string;
  type: "decision";
  createdAt: number;
}

type StoredItem = StoredLearning | StoredDecision;

/**
 * In-memory backend for tests and dry runs. Deterministic, no network, no state outside the instance.
 * Search uses naive case-insensitive substring matching weighted by recency — good enough to exercise
 * workflow paths without a live memory cluster.
 */
export class InMemoryMemoryClient implements MemoryClient {
  private readonly items: StoredItem[] = [];
  private idCounter = 0;

  /** Test-only: pre-seed memories. */
  seed(items: Array<LearnInput | (DecideInput & { _type?: "decision" })>): void {
    for (const item of items) {
      if ("decision" in item) {
        this.items.push({
          id: this.nextId("dec"),
          type: "decision",
          createdAt: Date.now(),
          ...item,
        });
      } else {
        this.items.push({
          id: this.nextId("lrn"),
          type: "learning",
          createdAt: Date.now(),
          ...item,
        });
      }
    }
  }

  /** Test-only: read all stored items. */
  dump(): readonly StoredItem[] {
    return [...this.items];
  }

  /** Test-only: drop everything. */
  reset(): void {
    this.items.length = 0;
    this.idCounter = 0;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    const limit = options.limit ?? 20;
    const needle = query.toLowerCase();
    const now = Date.now();
    const scored: Array<{ score: number; hit: SearchHit }> = [];
    for (const item of this.items) {
      const content = item.type === "decision" ? item.decision : item.content;
      if (!content.toLowerCase().includes(needle)) continue;
      if (options.project && item.project && item.project !== options.project) continue;
      const ageHours = (now - item.createdAt) / 3_600_000;
      const recency = 1 / (1 + ageHours / 24);
      scored.push({
        score: recency,
        hit: {
          id: item.id,
          type: item.type,
          content,
          project: item.project,
          date: new Date(item.createdAt).toISOString(),
          rank: recency,
        },
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((entry) => entry.hit);
  }

  async learn(input: LearnInput): Promise<PersistResult> {
    const stored: StoredLearning = {
      id: this.nextId("lrn"),
      type: "learning",
      createdAt: Date.now(),
      ...input,
    };
    this.items.push(stored);
    return { id: stored.id, ok: true };
  }

  async decide(input: DecideInput): Promise<PersistResult> {
    const stored: StoredDecision = {
      id: this.nextId("dec"),
      type: "decision",
      createdAt: Date.now(),
      ...input,
    };
    this.items.push(stored);
    return { id: stored.id, ok: true };
  }

  private nextId(prefix: string): string {
    this.idCounter += 1;
    return `${prefix}_${this.idCounter.toString().padStart(6, "0")}`;
  }
}
