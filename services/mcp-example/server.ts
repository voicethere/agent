import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

/** Sample data. Not real prices. */
export const SAMPLE_PLANS: Record<
  string,
  { pricePerMonthUsd: number; note: string }
> = {
  free: { pricePerMonthUsd: 0, note: "Sample data: for trying things out." },
  starter: { pricePerMonthUsd: 19, note: "Sample data: one small project." },
  team: { pricePerMonthUsd: 99, note: "Sample data: several projects." },
};

const MAX_BODY_BYTES = 1_048_576; // 1 MiB
const BODY_TIMEOUT_MS = 10_000;
const HANDLER_TIMEOUT_MS = 5_000;

export interface McpExampleOptions {
  port?: number;
  host?: string;
  /** When set, requests to /mcp need `Authorization: Bearer <token>`. */
  token?: string;
  /** Time allowed to receive a request body. Default 10 s. */
  bodyTimeoutMs?: number;
  /** One JSON line per event. Never receives tool arguments. */
  log?: (line: Record<string, unknown>) => void;
}

export interface McpExampleHandle {
  port: number;
  url: string;
  stop(): Promise<void>;
}

function bounded<T>(work: () => T | Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("handler timeout")),
      HANDLER_TIMEOUT_MS,
    );
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

function buildServer(log: (line: Record<string, unknown>) => void): McpServer {
  const server = new McpServer({
    name: "mcp-example-service",
    version: "1.0.0",
  });
  const run = async (
    tool: string,
    work: () => string,
  ): Promise<{
    content: { type: "text"; text: string }[];
    isError?: boolean;
  }> => {
    const started = Date.now();
    try {
      const text = await bounded(work);
      log({ event: "tool", tool, ok: true, ms: Date.now() - started });
      return { content: [{ type: "text", text }] };
    } catch {
      log({ event: "tool", tool, ok: false, ms: Date.now() - started });
      return {
        content: [{ type: "text", text: "The tool failed." }],
        isError: true,
      };
    }
  };
  server.registerTool(
    "get_plan_price",
    {
      description:
        "Monthly price of a plan (free, starter or team). Sample data, not real prices.",
      inputSchema: {
        plan: z.string().describe("Plan name: free, starter or team"),
      },
    },
    ({ plan }) =>
      run("get_plan_price", () => {
        const row = SAMPLE_PLANS[plan.trim().toLowerCase()];
        if (!row) {
          return `Unknown plan. Known plans: ${Object.keys(SAMPLE_PLANS).join(", ")}.`;
        }
        return JSON.stringify({ plan: plan.trim().toLowerCase(), ...row });
      }),
  );
  server.registerTool(
    "get_server_time",
    { description: "Current UTC time of this service.", inputSchema: {} },
    () => run("get_server_time", () => new Date().toISOString()),
  );
  return server;
}

type BodyFailure = "too_large" | "timeout" | "invalid_json" | "aborted";

class BodyError extends Error {
  constructor(readonly reason: BodyFailure) {
    super(reason);
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

/** Stateless streamable HTTP MCP server: GET /healthz and POST /mcp. */
export async function startMcpExample(
  opts: McpExampleOptions = {},
): Promise<McpExampleHandle> {
  const log = opts.log ?? (() => {});
  const http: Server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? "").split("?")[0];
      if (path === "/healthz") {
        send(res, 200, "ok");
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
        // Stateless server: no standalone SSE stream and no sessions to delete.
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
      const server = buildServer(log);
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
    stop: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? "8080");
  const token = process.env.MCP_TOKEN?.trim() || undefined;
  const handle = await startMcpExample({
    port,
    host: "0.0.0.0",
    token,
    log: (line) => console.log(JSON.stringify(line)),
  });
  console.log(
    JSON.stringify({ event: "listening", port: handle.port, auth: !!token }),
  );
  const stop = () => {
    void handle.stop().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
