import { afterEach, describe, expect, it } from "vitest";
import { McpToolSource } from "../../../src/llm/mcp/mcp-tool-source.js";
import { startTestMcpServer, type TestMcpServer } from "./mcp-test-server.js";

const sources: McpToolSource[] = [];
const servers: TestMcpServer[] = [];

function track(source: McpToolSource): McpToolSource {
  sources.push(source);
  return source;
}

async function server(port = 0): Promise<TestMcpServer> {
  const s = await startTestMcpServer(port);
  servers.push(s);
  return s;
}

afterEach(async () => {
  await Promise.all(sources.splice(0).map((s) => s.close()));
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

describe("McpToolSource", () => {
  it("lists tools after start and becomes ready", async () => {
    const srv = await server();
    const src = track(new McpToolSource({ name: "t", url: srv.url }));
    expect(src.status).toBe("idle");
    expect(src.tools()).toEqual([]);
    src.start();
    expect(await src.ready(5_000)).toBe(true);
    expect(src.status).toBe("ready");
    expect(
      src
        .tools()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["echo", "secret", "slow"]);
  });

  it("calls a tool and maps text content", async () => {
    const srv = await server();
    const src = track(new McpToolSource({ name: "t", url: srv.url }));
    src.start();
    await src.ready(5_000);
    const res = await src.callTool(
      "echo",
      { text: "hello" },
      { timeoutMs: 5_000 },
    );
    expect(res).toEqual({ content: "hello", isError: false });
    const missing = await src.callTool("nope", {}, { timeoutMs: 1_000 });
    expect(missing).toEqual({
      isError: true,
      content: "tool nope is not available",
    });
  });

  it("allow and deny filter the tool list", async () => {
    const srv = await server();
    const allowed = track(
      new McpToolSource({ name: "a", url: srv.url, allow: ["echo", "slow"] }),
    );
    const denied = track(
      new McpToolSource({ name: "d", url: srv.url, deny: ["slow"] }),
    );
    allowed.start();
    denied.start();
    await allowed.ready(5_000);
    await denied.ready(5_000);
    expect(
      allowed
        .tools()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["echo", "slow"]);
    expect(
      denied
        .tools()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["echo", "secret"]);
    const res = await denied.callTool("slow", {}, { timeoutMs: 1_000 });
    expect(res).toEqual({
      isError: true,
      content: "tool slow is not available",
    });
  });

  it("sends configured headers to the server", async () => {
    const srv = await server();
    const src = track(
      new McpToolSource({
        name: "t",
        url: srv.url,
        headers: { "x-test-token": "abc123" },
      }),
    );
    src.start();
    await src.ready(5_000);
    const res = await src.callTool("secret", {}, { timeoutMs: 5_000 });
    expect(res).toEqual({ content: "abc123", isError: false });
  });

  it("a call that exceeds timeoutMs returns an isError result and does not throw", async () => {
    const srv = await server();
    const src = track(new McpToolSource({ name: "t", url: srv.url }));
    src.start();
    await src.ready(5_000);
    const res = await src.callTool("slow", {}, { timeoutMs: 200 });
    expect(res).toEqual({
      isError: true,
      content: "tool slow failed: timeout",
    });
    expect(src.status).toBe("ready");
  });

  it("server down at start, then up: the source becomes ready after a retry", async () => {
    const probe = await startTestMcpServer();
    const port = probe.port;
    await probe.stop();
    const logs: string[] = [];
    const src = track(
      new McpToolSource({
        name: "t",
        url: `http://127.0.0.1:${port}/mcp`,
        backoffMs: [50],
        connectTimeoutMs: 1_000,
        log: (level, message) => logs.push(`${level}:${message}`),
      }),
    );
    src.start();
    expect(await src.ready(300)).toBe(false);
    expect(src.status).toBe("connecting");
    await server(port);
    expect(await src.ready(5_000)).toBe(true);
    expect(
      logs.filter((l) => l === "warn:mcp source connect failed"),
    ).toHaveLength(1);
  });

  it("tools/list_changed refreshes the list", async () => {
    const srv = await server();
    const src = track(new McpToolSource({ name: "t", url: srv.url }));
    src.start();
    await src.ready(5_000);
    expect(src.tools().map((t) => t.name)).not.toContain("extra");
    const mcp = srv.servers[0];
    mcp.registerTool("extra", { description: "new" }, async () => ({
      content: [{ type: "text", text: "x" }],
    }));
    // The client opens its notification stream right after ready, so the
    // first notification can race it; sending again is harmless.
    const deadline = Date.now() + 5_000;
    while (
      !src.tools().some((t) => t.name === "extra") &&
      Date.now() < deadline
    ) {
      mcp.sendToolListChanged();
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(src.tools().map((t) => t.name)).toContain("extra");
  });

  it("a dropped connection reconnects", async () => {
    const first = await server();
    const port = first.port;
    const src = track(
      new McpToolSource({
        name: "t",
        url: first.url,
        backoffMs: [50],
        connectTimeoutMs: 1_000,
      }),
    );
    src.start();
    await src.ready(5_000);
    await first.stop();
    const down = await src.callTool(
      "echo",
      { text: "x" },
      { timeoutMs: 1_000 },
    );
    expect(down.isError).toBe(true);
    expect(src.status).toBe("connecting");
    await server(port);
    expect(await src.ready(5_000)).toBe(true);
    const res = await src.callTool(
      "echo",
      { text: "back" },
      { timeoutMs: 5_000 },
    );
    expect(res).toEqual({ content: "back", isError: false });
  });
});
