import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export interface TestMcpServer {
  url: string;
  port: number;
  servers: McpServer[];
  stop(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch {
        resolve(undefined);
      }
    });
  });
}

function buildServer(headers: IncomingMessage["headers"]): McpServer {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  server.registerTool(
    "echo",
    { description: "echo text", inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: "text", text }] }),
  );
  server.registerTool(
    "slow",
    { description: "waits 5 s", inputSchema: {} },
    async () => {
      await new Promise((r) => setTimeout(r, 5_000));
      return { content: [{ type: "text", text: "late" }] };
    },
  );
  const token = String(headers["x-test-token"] ?? "");
  server.registerTool(
    "secret",
    { description: "returns the x-test-token header", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: token }] }),
  );
  return server;
}

/** Session-mode Streamable HTTP MCP server on 127.0.0.1. */
export async function startTestMcpServer(port = 0): Promise<TestMcpServer> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const servers: McpServer[] = [];
  const http: Server = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        const body = req.method === "POST" ? await readBody(req) : undefined;
        let transport = sessionId ? transports.get(sessionId) : undefined;
        if (!transport) {
          if (req.method === "POST" && isInitializeRequest(body)) {
            const t: StreamableHTTPServerTransport =
              new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (id) => {
                  transports.set(id, t);
                },
              });
            const server = buildServer(req.headers);
            servers.push(server);
            await server.connect(t);
            transport = t;
          } else {
            res.writeHead(404).end();
            return;
          }
        }
        await transport.handleRequest(req, res, body);
      })();
    },
  );
  await new Promise<void>((resolve) => http.listen(port, "127.0.0.1", resolve));
  const actual = (http.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${actual}/mcp`,
    port: actual,
    servers,
    stop: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}
