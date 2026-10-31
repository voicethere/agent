import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { MANIFEST } from "./build-index.ts";
import { type Embedder, createEmbedder } from "./embed.ts";
import { type Index, openIndex, searchHybrid } from "./search.ts";

export const MAX_SEARCH_CHARS = 4000;
export const MAX_DOC_CHARS = 12000;
const MAX_BODY_BYTES = 1_048_576; // 1 MiB
const BODY_TIMEOUT_MS = 10_000;
/** Bound for one tool call (embedding + both searches). */
export const HANDLER_TIMEOUT_MS = 5_000;

const DEFAULT_DESCRIPTION =
  "Search the documentation. Returns the best matching passages, each with its page title, URL and page id.";

export interface DocsRagOptions {
  port?: number;
  host?: string;
  /** Directory with manifest.json, vectors.db and text.db. */
  indexDir: string;
  /** Directory with the embedding model (see `download-model`). */
  modelDir?: string;
  /** Test hook: use this embedder instead of loading the model. */
  embedder?: Embedder;
  /** When set, requests to /mcp need `Authorization: Bearer <token>`. */
  token?: string;
  /** Prefix for both tool names, e.g. `acme_` gives `acme_search_docs`. */
  toolPrefix?: string;
  /** Description of the search tool, e.g. "Search the Acme docs". */
  description?: string;
  bodyTimeoutMs?: number;
  handlerTimeoutMs?: number;
  /** One JSON line per event. Never receives queries or passage text. */
  log?: (line: Record<string, unknown>) => void;
}

export interface DocsRagHandle {
  port: number;
  url: string;
  /** Resolves when both databases and the model are loaded. */
  ready: Promise<void>;
  stop(): Promise<void>;
}

/** Named startup failure; the process prints `code` and exits 1. */
export class DocsRagStartError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const PREFIX_RE = /^[A-Za-z0-9_]{0,32}$/;

export function toolNames(prefix = ""): { search: string; doc: string } {
  if (!PREFIX_RE.test(prefix)) {
    throw new DocsRagStartError(
      "DOCS_RAG_TOOL_PREFIX_INVALID",
      "DOCS_RAG_TOOL_PREFIX must be at most 32 letters, digits or underscores",
    );
  }
  return { search: `${prefix}search_docs`, doc: `${prefix}get_doc` };
}

function bounded<T>(ms: number, work: () => T | Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("handler timeout")), ms);
    Promise.resolve()
      .then(work)
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}

function tokenOk(header: string | undefined, token: string): boolean {
  const want = Buffer.from(`Bearer ${token}`);
  const got = Buffer.from(header ?? "");
  return got.length === want.length && timingSafeEqual(got, want);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Numbered hits `N. title — url (id: doc)\ntext`, at most `max` characters. */
export function formatHits(
  hits: Array<{ docId: string; title: string; url: string; text: string }>,
  max = MAX_SEARCH_CHARS,
): string {
  if (hits.length === 0) return "No results.";
  const parts: string[] = [];
  let used = 0;
  for (const [i, h] of hits.entries()) {
    const head = `${i + 1}. ${h.title}${h.url ? ` — ${h.url}` : ""} (id: ${h.docId})\n`;
    const sep = parts.length > 0 ? 2 : 0;
    const room = max - used - sep - head.length;
    if (room < 80 && parts.length > 0) break;
    const body = clip(h.text, Math.max(room, 0));
    parts.push(head + body);
    used += sep + head.length + body.length;
    if (used >= max) break;
  }
  return parts.join("\n\n");
}

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

interface Runtime {
  index: Index;
}

function buildServer(
  rt: Promise<Runtime>,
  opts: DocsRagOptions,
  log: (line: Record<string, unknown>) => void,
): McpServer {
  const names = toolNames(opts.toolPrefix);
  const handlerMs = opts.handlerTimeoutMs ?? HANDLER_TIMEOUT_MS;
  const description = opts.description?.trim() || DEFAULT_DESCRIPTION;
  const server = new McpServer({ name: "docs-rag-mcp", version: "1.0.0" });
  const run = async (
    tool: string,
    extra: Record<string, unknown>,
    work: (r: Runtime) => Promise<{ text: string; hits?: number }>,
  ): Promise<ToolResult> => {
    const started = Date.now();
    try {
      const out = await bounded(handlerMs, async () => work(await rt));
      log({
        event: "tool",
        tool,
        ...extra,
        hits: out.hits,
        ok: true,
        ms: Date.now() - started,
      });
      return { content: [{ type: "text", text: out.text }] };
    } catch {
      log({
        event: "tool",
        tool,
        ...extra,
        ok: false,
        ms: Date.now() - started,
      });
      return {
        content: [{ type: "text", text: "The tool failed." }],
        isError: true,
      };
    }
  };
  server.registerTool(
    names.search,
    {
      description,
      inputSchema: {
        query: z.string().min(1).max(500).describe("What to look for"),
        k: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe("Number of passages to return, 1 to 10 (default 5)"),
      },
    },
    ({ query, k }) =>
      run(names.search, { k: k ?? 5 }, async ({ index }) => {
        const hits = await searchHybrid(index, query, k ?? 5);
        return { text: formatHits(hits), hits: hits.length };
      }),
  );
  server.registerTool(
    names.doc,
    {
      description:
        "Full text of one documentation page, by the page id from a search result.",
      inputSchema: {
        id: z.string().min(1).max(300).describe("Page id from a search result"),
      },
    },
    ({ id }) =>
      run(names.doc, {}, async ({ index }) => {
        const doc = index.doc(id);
        if (!doc) return { text: "not found", hits: 0 };
        const head = `${doc.title}${doc.url ? ` — ${doc.url}` : ""}\n\n`;
        return {
          text: head + clip(doc.text, MAX_DOC_CHARS - head.length),
          hits: 1,
        };
      }),
  );
  return server;
}

type BodyFailure = "too_large" | "timeout" | "invalid_json" | "aborted";

class BodyError extends Error {
  readonly reason: BodyFailure;
  constructor(reason: BodyFailure) {
    super(reason);
    this.reason = reason;
  }
}

function readBody(req: IncomingMessage, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off("data", onData);
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new BodyError("timeout"))),
      timeoutMs,
    );
    const onData = (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        finish(() => reject(new BodyError("too_large")));
        return;
      }
      chunks.push(c);
    };
    req.on("data", onData);
    req.on("end", () =>
      finish(() => {
        const raw = Buffer.concat(chunks).toString("utf8");
        try {
          resolve(raw ? JSON.parse(raw) : undefined);
        } catch {
          reject(new BodyError("invalid_json"));
        }
      }),
    );
    req.on("error", () => finish(() => reject(new BodyError("aborted"))));
    req.on("close", () => finish(() => reject(new BodyError("aborted"))));
  });
}

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/plain" }).end(body);
}

/**
 * Stateless streamable HTTP MCP server: GET /healthz (200 once the model and
 * both databases are loaded, 503 before) and POST /mcp.
 * Throws `DocsRagStartError` when the index is missing.
 */
export async function startDocsRagServer(
  opts: DocsRagOptions,
): Promise<DocsRagHandle> {
  const log = opts.log ?? (() => {});
  toolNames(opts.toolPrefix);
  if (!existsSync(join(opts.indexDir, MANIFEST))) {
    throw new DocsRagStartError(
      "DOCS_RAG_INDEX_MISSING",
      `no ${MANIFEST} in ${opts.indexDir}: build the index first (docs-rag build --docs <dir> --out ${opts.indexDir})`,
    );
  }
  const loadStarted = Date.now();
  const runtime: Promise<Runtime> = (async () => {
    const embedder = opts.embedder ?? (await createEmbedder(opts.modelDir));
    const index = openIndex(opts.indexDir, embedder);
    // Warm the model so the first real query does not pay for it.
    await embedder.embedQuery("warm up");
    log({
      event: "ready",
      chunks: index.manifest.chunks,
      ms: Date.now() - loadStarted,
    });
    return { index };
  })();
  let loaded = false;
  let loadFailed = false;
  runtime.then(
    () => {
      loaded = true;
    },
    () => {
      loadFailed = true;
      log({ event: "load_failed" });
    },
  );

  const http: Server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? "").split("?")[0];
      if (path === "/healthz") {
        if (loaded) send(res, 200, "ok");
        else send(res, 503, loadFailed ? "load failed" : "loading");
        return;
      }
      if (path !== "/mcp") {
        send(res, 404, "not found");
        return;
      }
      if (opts.token && !tokenOk(req.headers.authorization, opts.token)) {
        log({ event: "unauthorized" });
        send(res, 401, "unauthorized");
        return;
      }
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        send(res, 405, "method not allowed");
        return;
      }
      let body: unknown;
      try {
        body = await readBody(req, opts.bodyTimeoutMs ?? BODY_TIMEOUT_MS);
      } catch (err) {
        const reason = err instanceof BodyError ? err.reason : "aborted";
        log({ event: "bad_body", reason });
        res.setHeader("Connection", "close");
        if (reason === "too_large") send(res, 413, "payload too large");
        else if (reason === "timeout") send(res, 408, "request timeout");
        else send(res, 400, "bad request");
        return;
      }
      const server = buildServer(runtime, opts, log);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    })().catch(() => {
      log({ event: "error" });
      if (!res.headersSent) send(res, 500, "internal error");
      else res.end();
    });
  });
  await new Promise<void>((resolve) =>
    http.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve),
  );
  const port = (http.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    ready: runtime.then(() => undefined),
    stop: async () => {
      await new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      });
      await runtime.then(
        ({ index }) => index.close(),
        () => undefined,
      );
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = (line: Record<string, unknown>) =>
    console.log(JSON.stringify(line));
  try {
    const token = process.env.MCP_TOKEN?.trim() || undefined;
    const handle = await startDocsRagServer({
      port: Number(process.env.PORT ?? "8080"),
      host: "0.0.0.0",
      indexDir: process.env.INDEX_DIR ?? "/index",
      modelDir: process.env.DOCS_RAG_MODEL_DIR,
      token,
      toolPrefix: process.env.DOCS_RAG_TOOL_PREFIX,
      description: process.env.DOCS_RAG_DESCRIPTION,
      log: out,
    });
    out({ event: "listening", port: handle.port, auth: !!token });
    handle.ready.catch(() => process.exit(1));
    const stop = () => {
      void handle.stop().then(() => process.exit(0));
      setTimeout(() => process.exit(0), 3_000).unref();
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  } catch (err) {
    if (err instanceof DocsRagStartError) {
      out({ event: "start_failed", code: err.code, message: err.message });
    } else {
      out({ event: "start_failed", code: "DOCS_RAG_START_FAILED" });
    }
    process.exit(1);
  }
}
