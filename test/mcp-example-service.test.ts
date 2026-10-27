import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { McpToolSource } from "../src/llm/mcp/mcp-tool-source.js";
import {
  startMcpExample,
  type McpExampleHandle,
} from "../services/mcp-example/server.js";

const handles: McpExampleHandle[] = [];
const sources: McpToolSource[] = [];

async function start(token?: string, bodyTimeoutMs?: number) {
  const lines: Record<string, unknown>[] = [];
  const handle = await startMcpExample({
    token,
    bodyTimeoutMs,
    log: (l) => lines.push(l),
  });
  handles.push(handle);
  return { handle, lines };
}

afterEach(async () => {
  for (const s of sources.splice(0))
    await (s as { close?: () => Promise<void> }).close?.();
  for (const h of handles.splice(0)) await h.stop();
});

function source(url: string, headers?: Record<string, string>): McpToolSource {
  const s = new McpToolSource({
    name: "svc",
    kind: "service",
    url,
    headers,
    backoffMs: [50],
  });
  sources.push(s);
  s.start();
  return s;
}

describe("mcp example service", () => {
  it("answers /healthz with 200", async () => {
    const { handle } = await start();
    const res = await fetch(`http://127.0.0.1:${handle.port}/healthz`);
    expect(res.status).toBe(200);
  });

  it("the agent's MCP tool source lists both tools and calls get_plan_price", async () => {
    const { handle, lines } = await start("s3cret");
    const src = source(handle.url, { Authorization: "Bearer s3cret" });
    expect(await src.ready(5_000)).toBe(true);
    expect(
      src
        .tools()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["get_plan_price", "get_server_time"]);
    const res = await src.callTool(
      "get_plan_price",
      { plan: "Starter" },
      { timeoutMs: 5_000 },
    );
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.content)).toMatchObject({
      plan: "starter",
      pricePerMonthUsd: 19,
    });
    const time = await src.callTool(
      "get_server_time",
      {},
      { timeoutMs: 5_000 },
    );
    expect(new Date(time.content).toISOString()).toBe(time.content);
    // Log lines carry the tool name and outcome, never the arguments.
    const toolLines = lines.filter((l) => l.event === "tool");
    expect(toolLines.map((l) => l.tool)).toContain("get_plan_price");
    expect(JSON.stringify(lines)).not.toMatch(/Starter|starter/);
  });

  it("an unknown plan names the known plans", async () => {
    const { handle } = await start();
    const src = source(handle.url);
    await src.ready(5_000);
    const res = await src.callTool(
      "get_plan_price",
      { plan: "gold" },
      { timeoutMs: 5_000 },
    );
    expect(res.content).toContain("free, starter, team");
  });

  it("rejects a missing or wrong bearer with 401", async () => {
    const { handle, lines } = await start("s3cret");
    const init = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    };
    const base = {
      method: "POST",
      body: JSON.stringify(init),
    };
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    const none = await fetch(handle.url, { ...base, headers });
    expect(none.status).toBe(401);
    const wrong = await fetch(handle.url, {
      ...base,
      headers: { ...headers, Authorization: "Bearer nope" },
    });
    expect(wrong.status).toBe(401);
    const ok = await fetch(handle.url, {
      ...base,
      headers: { ...headers, Authorization: "Bearer s3cret" },
    });
    expect(ok.status).toBe(200);
    expect(lines.filter((l) => l.event === "unauthorized")).toHaveLength(2);
  });

  it("GET /mcp is 405 (stateless server)", async () => {
    const { handle } = await start();
    const res = await fetch(handle.url);
    expect(res.status).toBe(405);
  });

  it("a body above 1 MiB gets 413 and a log line without content", async () => {
    const { handle, lines } = await start();
    const res = await fetch(handle.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(1_048_576 + 10) }),
    });
    expect(res.status).toBe(413);
    expect(lines).toContainEqual({ event: "bad_body", reason: "too_large" });
    expect(JSON.stringify(lines)).not.toContain("xxxx");
  });

  it("a client that sends headers and never finishes the body gets 408", async () => {
    const { handle, lines } = await start(undefined, 150);
    const status = await new Promise<number>((resolve, reject) => {
      const socket = connect(handle.port, "127.0.0.1", () => {
        socket.write(
          "POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{",
        );
      });
      let data = "";
      socket.on("data", (d) => {
        data += d.toString();
        const m = /^HTTP\/1\.1 (\d+)/.exec(data);
        if (m) {
          socket.destroy();
          resolve(Number(m[1]));
        }
      });
      socket.on("error", reject);
      setTimeout(() => reject(new Error("no response")), 3_000).unref();
    });
    expect(status).toBe(408);
    expect(lines).toContainEqual({ event: "bad_body", reason: "timeout" });
  });
});
