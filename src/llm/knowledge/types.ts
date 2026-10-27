import type { LlmEmbedder } from "../types.js";

export interface KnowledgeDocument {
  /** Stable id (file name). Becomes `KnowledgeHit.source`. */
  id: string;
  /** Markdown. */
  text: string;
  /** First element of every chunk title in this document. */
  title?: string;
}

export interface KnowledgeHit {
  text: string;
  /** Heading path, e.g. "Billing › Plans". */
  title: string;
  /** Id of the document the chunk came from. */
  source: string;
  /** 1 - cosine distance; higher is closer. */
  score: number;
}

export interface IndexReport {
  /**
   * `fresh`: the active index already matches the documents (nothing embedded).
   * `rebuilt`: this worker embedded and swapped in a new index.
   * `built-by-other-worker`: another worker did it while this one waited.
   */
  status: "fresh" | "rebuilt" | "built-by-other-worker";
  chunks: number;
  waitedMs: number;
  contentHash: string;
}

export interface KnowledgeBase {
  ensureIndexed(): Promise<IndexReport>;
  search(query: string, k?: number): Promise<KnowledgeHit[]>;
  /** Closes the Redis connection only when this knowledge base opened it. */
  close(): Promise<void>;
}

export type KnowledgeIndexErrorCode =
  "KB_INDEX_TIMEOUT" | "KB_MEMORY_LIMIT" | "KB_REDIS_ERROR";

export class KnowledgeIndexError extends Error {
  readonly code: KnowledgeIndexErrorCode;
  constructor(code: KnowledgeIndexErrorCode, message: string) {
    super(message);
    this.name = "KnowledgeIndexError";
    this.code = code;
  }
}

/** The part of an ioredis client the knowledge base uses. */
export interface KnowledgeRedisPipeline {
  call(command: string, ...args: Array<string | number | Buffer>): unknown;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

export interface KnowledgeRedisClient {
  call(
    command: string,
    ...args: Array<string | number | Buffer>
  ): Promise<unknown>;
  pipeline(): KnowledgeRedisPipeline;
  on?(event: "error", listener: (err: Error) => void): unknown;
  quit(): Promise<unknown>;
  disconnect(): void;
}

export interface KnowledgeLogger {
  /** Fields hold counts, ids and durations only, never chunk or query text. */
  info(message: string, fields?: Record<string, unknown>): void;
}

export interface KnowledgeLimits {
  /** Per Redis command. Default 5000. */
  redisTimeoutMs?: number;
  /** FT.CREATE and each write pipeline. Default 30000. */
  buildTimeoutMs?: number;
  /** Wait for the index to finish indexing. Default 30000. */
  indexReadyTimeoutMs?: number;
  /** Build lock lifetime. Default 120000. */
  lockTtlMs?: number;
  /** How long a worker waits for another worker's build. Default 120000. */
  waitForOtherMs?: number;
  /** Poll interval while waiting. Default 250. */
  pollMs?: number;
  /** Refuse to write past this share of maxmemory. Default 0.8. */
  memoryFraction?: number;
  /** Overrides Redis `maxmemory` (0 = unlimited). Mainly for tests. */
  maxmemoryBytes?: number;
}

export interface RedisKnowledgeBaseOptions {
  /** Open (and own) a connection with ioredis. Needs `ioredis` installed. */
  redisUrl?: string;
  /** An ioredis client you manage. */
  redis?: KnowledgeRedisClient;
  /** Key prefix scope, `[A-Za-z0-9._-]+`. Default "default". */
  namespace?: string;
  documents: KnowledgeDocument[];
  embedder: LlmEmbedder;
  model: string;
  /** Default `DEFAULT_EMBEDDING_DIMS` (512). */
  dims?: number;
  maxWords?: number;
  overlapWords?: number;
  logger?: KnowledgeLogger;
  limits?: KnowledgeLimits;
}
