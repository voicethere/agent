import { createRequire } from "node:module";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildDiscoveryFields, toolsHash } from "./discovery.js";

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type McpSourceStatus = "idle" | "connecting" | "ready" | "closed";

export type McpLogFn = (
  level: "info" | "warn",
  message: string,
  fields?: Record<string, unknown>,
) => void;

export interface McpToolSourceOptions {
  name: string;
  url: string;
  headers?: Record<string, string>;
  allow?: string[];
  deny?: string[];
  /** Reported in the discovery log line. Default "mcp". */
  kind?: "mcp" | "service";
  connectTimeoutMs?: number;
  log?: McpLogFn;
  now?: () => number;
  /** Retry delays; the last entry repeats. Default 1, 2, 4, 8, 16, then 30 s. */
  backoffMs?: number[];
}

export interface McpCallResult {
  content: string;
  isError: boolean;
}

const DEFAULT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const MAX_LIST_PAGES = 10;
/** JSON-RPC code the MCP SDK uses for a request timeout (`ErrorCode.RequestTimeout`). */
const REQUEST_TIMEOUT_CODE = -32001;

function readPackageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const AGENT_VERSION = readPackageVersion();

function errorFields(err: unknown): { error: string } {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    const name = err.constructor.name || err.name;
    return {
      error: code !== undefined ? `${name} ${String(code)}` : name,
    };
  }
  return { error: typeof err };
}

function urlOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "invalid-url";
  }
}

type RawContentItem = {
  type?: string;
  text?: string;
  resource?: { uri?: string };
  uri?: string;
};

function mapToolResult(result: {
  content?: unknown;
  structuredContent?: unknown;
  isError?: unknown;
}): McpCallResult {
  const items = Array.isArray(result.content)
    ? (result.content as RawContentItem[])
    : [];
  const parts: string[] = [];
  let hasText = false;
  for (const item of items) {
    switch (item.type) {
      case "text":
        hasText = true;
        parts.push(String(item.text ?? ""));
        break;
      case "image":
        parts.push("[image]");
        break;
      case "audio":
        parts.push("[audio]");
        break;
      case "resource":
        parts.push(`[resource ${item.resource?.uri ?? ""}]`);
        break;
      case "resource_link":
        parts.push(`[resource ${item.uri ?? ""}]`);
        break;
      default:
        parts.push(`[${String(item.type ?? "unknown")}]`);
    }
  }
  let content = parts.join("\n");
  if (!hasText && result.structuredContent !== undefined) {
    content = JSON.stringify(result.structuredContent);
  }
  return { content, isError: result.isError === true };
}

/**
 * Streamable HTTP MCP client for one server. Connects in the background,
 * caches the tool list and reconnects with backoff until `close()`.
 */
export class McpToolSource {
  readonly name: string;
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly allow: Set<string>;
  private readonly deny: Set<string>;
  private readonly connectTimeoutMs: number;
  private readonly log: McpLogFn;
  readonly kind: "mcp" | "service";
  private lastDiscoveryHash: string | undefined;
  private readonly backoff: number[];

  private state: McpSourceStatus = "idle";
  private client: Client | undefined;
  private cached: McpToolInfo[] = [];
  private attempt = 0;
  private warnedThisStreak = false;
  private looping = false;
  private sleepTimer: ReturnType<typeof setTimeout> | undefined;
  private sleepWake: (() => void) | undefined;
  private waiters = new Set<(ok: boolean) => void>();

  constructor(opts: McpToolSourceOptions) {
    this.name = opts.name;
    this.url = opts.url;
    this.headers = { ...(opts.headers ?? {}) };
    this.allow = new Set(opts.allow ?? []);
    this.deny = new Set(opts.deny ?? []);
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
    this.log = opts.log ?? (() => {});
    this.kind = opts.kind ?? "mcp";
    this.backoff =
      opts.backoffMs && opts.backoffMs.length > 0
        ? opts.backoffMs
        : DEFAULT_BACKOFF_MS;
  }

  get status(): McpSourceStatus {
    return this.state;
  }

  start(): void {
    if (this.state !== "idle") return;
    this.state = "connecting";
    this.kickLoop();
  }

  ready(timeoutMs: number): Promise<boolean> {
    if (this.state === "ready") return Promise.resolve(true);
    if (this.state === "closed") return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), Math.max(0, timeoutMs));
      this.waiters.add(done);
    });
  }

  tools(): McpToolInfo[] {
    if (this.state !== "ready") return [];
    return this.cached.map((t) => ({ ...t }));
  }

  async callTool(
    name: string,
    args: unknown,
    opts: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<McpCallResult> {
    const client = this.client;
    if (
      this.state !== "ready" ||
      !client ||
      !this.cached.some((t) => t.name === name)
    ) {
      return { isError: true, content: `tool ${name} is not available` };
    }
    try {
      const result = await client.callTool(
        { name, arguments: (args ?? {}) as Record<string, unknown> },
        undefined,
        { signal: opts.signal, timeout: opts.timeoutMs },
      );
      return mapToolResult(result as Parameters<typeof mapToolResult>[0]);
    } catch (err) {
      if (opts.signal?.aborted) {
        return { isError: true, content: `tool ${name} failed: aborted` };
      }
      const code = (err as { code?: unknown } | null)?.code;
      if (code === REQUEST_TIMEOUT_CODE) {
        return { isError: true, content: `tool ${name} failed: timeout` };
      }
      if (typeof code === "number" && code < 0) {
        // JSON-RPC error from a live server (HTTP statuses are positive): the connection is fine.
        return { isError: true, content: `tool ${name} failed: unavailable` };
      }
      this.connectionLost(client, err);
      return { isError: true, content: `tool ${name} failed: unavailable` };
    }
  }

  async close(): Promise<void> {
    if (this.state === "closed") return;
    this.state = "closed";
    this.cached = [];
    if (this.sleepTimer) clearTimeout(this.sleepTimer);
    this.sleepWake?.();
    for (const w of [...this.waiters]) w(false);
    const client = this.client;
    this.client = undefined;
    if (client) {
      client.onclose = undefined;
      await client.close().catch(() => {});
    }
  }

  private isClosed(): boolean {
    return this.state === "closed";
  }

  private kickLoop(): void {
    if (this.looping) return;
    this.looping = true;
    void this.loop().finally(() => {
      this.looping = false;
    });
  }

  private async loop(): Promise<void> {
    while (!this.isClosed()) {
      try {
        await this.connectOnce();
        if (this.isClosed()) return;
        this.attempt = 0;
        this.warnedThisStreak = false;
        this.state = "ready";
        this.log("info", "mcp source ready", {
          source: this.name,
          origin: urlOrigin(this.url),
          tools: this.cached.length,
        });
        for (const w of [...this.waiters]) w(true);
        return;
      } catch (err) {
        if (this.isClosed()) return;
        this.attempt += 1;
        if (!this.warnedThisStreak) {
          this.warnedThisStreak = true;
          this.log("warn", "mcp source connect failed", {
            source: this.name,
            origin: urlOrigin(this.url),
            attempt: this.attempt,
            ...errorFields(err),
          });
        }
        await this.sleep(
          this.backoff[Math.min(this.attempt - 1, this.backoff.length - 1)],
        );
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.sleepWake = resolve;
      this.sleepTimer = setTimeout(resolve, ms);
    }).then(() => {
      this.sleepWake = undefined;
      this.sleepTimer = undefined;
    });
  }

  private connectionLost(client: Client, err: unknown): void {
    if (this.isClosed() || this.client !== client) return;
    this.client = undefined;
    this.state = "connecting";
    this.cached = [];
    this.attempt = 0;
    this.warnedThisStreak = true;
    this.log("warn", "mcp source connection lost", {
      source: this.name,
      origin: urlOrigin(this.url),
      ...errorFields(err),
    });
    client.onclose = undefined;
    void client.close().catch(() => {});
    this.warnedThisStreak = false;
    this.kickLoop();
  }

  private filter(tools: McpToolInfo[]): McpToolInfo[] {
    return tools.filter(
      (t) =>
        (this.allow.size === 0 || this.allow.has(t.name)) &&
        !this.deny.has(t.name),
    );
  }

  private async listAll(client: Client): Promise<McpToolInfo[]> {
    const out: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const res = await client.listTools(cursor ? { cursor } : undefined);
      for (const t of res.tools) {
        out.push({
          name: t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema as Record<string, unknown>,
        });
      }
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    const hash = toolsHash(out);
    if (hash !== this.lastDiscoveryHash) {
      this.lastDiscoveryHash = hash;
      const exposed = new Set(this.filter(out).map((t) => t.name));
      this.log(
        "info",
        "llm tools discovered",
        buildDiscoveryFields(this.name, this.kind, out, (n) => exposed.has(n)),
      );
    }
    return this.filter(out);
  }

  private async connectOnce(): Promise<void> {
    const [{ Client: McpClient }, { StreamableHTTPClientTransport }, types] =
      await Promise.all([
        import("@modelcontextprotocol/sdk/client/index.js"),
        import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
        import("@modelcontextprotocol/sdk/types.js"),
      ]);
    const client = new McpClient({
      name: "voicethere-agent",
      version: AGENT_VERSION,
    });
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: { headers: this.headers },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.connect(transport),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              Object.assign(new Error("connect timeout"), {
                code: "CONNECT_TIMEOUT",
              }),
            );
          }, this.connectTimeoutMs);
        }),
      ]);
      const tools = await this.listAll(client);
      if (this.isClosed()) {
        await client.close().catch(() => {});
        return;
      }
      this.cached = tools;
      client.setNotificationHandler(
        types.ToolListChangedNotificationSchema,
        async () => {
          try {
            this.cached = await this.listAll(client);
          } catch (err) {
            this.log("warn", "mcp tool list refresh failed", {
              source: this.name,
              ...errorFields(err),
            });
          }
        },
      );
      client.onclose = () => this.connectionLost(client, new Error("closed"));
      client.onerror = () => {};
      this.client = client;
    } catch (err) {
      await client.close().catch(() => {});
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
