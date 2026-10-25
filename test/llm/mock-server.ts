import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockReply {
  status?: number;
  /** Raw SSE text sent as the body (status 200 default). */
  sse?: string;
  /** JSON error body for non-200 replies. */
  json?: unknown;
  /** Never answer. */
  hang?: boolean;
  /** Send the SSE, then stall without ending the response. */
  stallAfter?: boolean;
}

export interface MockServer {
  baseUrl: string;
  requests: { url: string; body: any }[];
  close(): Promise<void>;
}

export async function startMock(replies: MockReply[]): Promise<MockServer> {
  const requests: { url: string; body: any }[] = [];
  const open = new Set<import("node:net").Socket>();
  let n = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body: any = undefined;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        /* none */
      }
      requests.push({ url: req.url ?? "", body });
      const reply = replies[Math.min(n, replies.length - 1)];
      n += 1;
      if (reply.hang) return;
      const status = reply.status ?? 200;
      if (status !== 200) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(
          JSON.stringify(reply.json ?? { error: { message: "SECRET-BODY" } }),
        );
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      res.write(reply.sse ?? "");
      if (!reply.stallAfter) res.end();
    });
  });
  server.on("connection", (s) => {
    open.add(s);
    s.on("close", () => open.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        for (const s of open) s.destroy();
        server.close(() => r());
      }),
  };
}

export function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

export function sseEvent(event: string, obj: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}
