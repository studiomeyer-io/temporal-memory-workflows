export type LearningCategory =
  | "pattern"
  | "mistake"
  | "insight"
  | "research"
  | "architecture"
  | "infrastructure"
  | "tool"
  | "workflow"
  | "performance"
  | "security";

export type DecisionConfidence = number;

export interface SearchOptions {
  limit?: number;
  project?: string;
  types?: Array<"decision" | "learning" | "session" | "skill" | "entity">;
  recencyWeight?: number;
}

export interface SearchHit {
  id: string;
  type: "decision" | "learning" | "session" | "skill" | "entity";
  content: string;
  project?: string;
  date?: string;
  rank?: number;
  rrfScore?: number;
}

export interface LearnInput {
  content: string;
  category: LearningCategory;
  project?: string;
  tags?: string[];
  confidence?: number;
}

export interface DecideInput {
  title: string;
  decision: string;
  reasoning?: string;
  alternatives?: string;
  project?: string;
  tags?: string[];
  confidence?: DecisionConfidence;
}

export interface PersistResult {
  id: string;
  ok: true;
}

/**
 * Memory client contract. Any backend (hosted REST, local SQLite, in-memory mock)
 * implements this interface so workflows depend on the contract, not the transport.
 */
export interface MemoryClient {
  search(query: string, options?: SearchOptions): Promise<SearchHit[]>;
  learn(input: LearnInput): Promise<PersistResult>;
  decide(input: DecideInput): Promise<PersistResult>;
}

export class MemoryClientError extends Error {
  readonly status?: number;
  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "MemoryClientError";
    this.status = options?.status;
  }
}
