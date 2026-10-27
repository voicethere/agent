import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  buildDiscoveryFields,
  TOOLS_DISCOVERED_EVENT,
} from "../../../src/llm/mcp/discovery.js";
import { sanitizeAgentLogFields } from "../../../src/runtime.js";
import {
  McpToolSource,
  type McpToolInfo,
} from "../../../src/llm/mcp/mcp-tool-source.js";
import { startTestMcpServer, type TestMcpServer } from "./mcp-test-server.js";

const sources: McpToolSource[] = [];
const servers: TestMcpServer[] = [];

afterEach(async () => {
  await Promise.all(sources.splice(0).map((s) => s.close()));
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

interface Logged {
  level: string;
  message: string;
  fields?: Record<string, unknown>;
}

async function run(
  extra: { allow?: string[]; deny?: string[] } = {},
  port = 0,
) {
  const srv = await startTestMcpServer(port);
  servers.push(srv);
  const logs: Logged[] = [];
  const src = new McpToolSource({
    name: "t",
    url: srv.url,
    headers: { Authorization: "Bearer topsecret" },
    log: (level, message, fields) => logs.push({ level, message, fields }),
    backoffMs: [20],
    ...extra,
  });
  sources.push(src);
  src.start();
  expect(await src.ready(5_000)).toBe(true);
  const discovered = () =>
    logs.filter((l) => l.message === "llm tools discovered");
  return { srv, src, logs, discovered };
}

type Fields = {
  tools: { name: string; description: string; exposed: boolean }[];
  truncated: boolean;
  kind: string;
  event: string;
};

describe("tool discovery log", () => {
  it("logs all tools with exposed flags", async () => {
    const { discovered } = await run({ allow: ["echo"] });
    expect(discovered()).toHaveLength(1);
    const f = discovered()[0].fields as unknown as Fields;
    expect(f.event).toBe(TOOLS_DISCOVERED_EVENT);
    expect(f.kind).toBe("mcp");
    const byName = Object.fromEntries(f.tools.map((t) => [t.name, t.exposed]));
    expect(byName).toEqual({ echo: true, secret: false, slow: false });
  });

  it("deny hides but still lists", async () => {
    const { discovered, src } = await run({ deny: ["slow"] });
    const f = discovered()[0].fields as unknown as Fields;
    expect(f.tools.map((t) => t.name).sort()).toEqual([
      "echo",
      "secret",
      "slow",
    ]);
    expect(f.tools.find((t) => t.name === "slow")?.exposed).toBe(false);
    expect(src.tools().map((t) => t.name)).not.toContain("slow");
  });

  it("no second log on reconnect with the same tools", async () => {
    const { srv, src, discovered, logs } = await run();
    expect(discovered()).toHaveLength(1);
    const port = srv.port;
    await srv.stop();
    servers.splice(servers.indexOf(srv), 1);
    const down = await src.callTool(
      "echo",
      { text: "x" },
      { timeoutMs: 1_000 },
    );
    expect(down.isError).toBe(true);
    expect(src.status).toBe("connecting");
    servers.push(await startTestMcpServer(port));
    expect(await src.ready(5_000)).toBe(true);
    expect(logs.filter((l) => l.message === "mcp source ready")).toHaveLength(
      2,
    );
    expect(discovered()).toHaveLength(1);
  });

  it("logs again when the server's tools change", async () => {
    const { srv, discovered } = await run();
    await srv.standaloneSseOpen();
    srv.servers[0].registerTool(
      "extra",
      { description: "new tool", inputSchema: { x: z.string() } },
      async () => ({ content: [{ type: "text", text: "x" }] }),
    );
    await vi.waitFor(() => expect(discovered()).toHaveLength(2), {
      timeout: 5_000,
    });
    expect(discovered()).toHaveLength(2);
    const f = discovered()[1].fields as unknown as Fields;
    expect(f.tools.map((t) => t.name)).toContain("extra");
  });

  it("fields contain no url, origin, headers or inputSchema", async () => {
    const { discovered, srv } = await run();
    const json = JSON.stringify(discovered()[0].fields);
    expect(json).not.toContain(srv.url);
    expect(json).not.toContain("127.0.0.1");
    expect(json).not.toContain("topsecret");
    expect(json).not.toContain("inputSchema");
    expect(json).not.toContain("origin");
  });
});

describe("buildDiscoveryFields", () => {
  const tool = (name: string, description = ""): McpToolInfo => ({
    name,
    description,
    inputSchema: { type: "object" },
  });

  it("caps at 128 and sets truncated", () => {
    const all = Array.from({ length: 130 }, (_, i) => tool(`t${i}`));
    const f = buildDiscoveryFields("s", "mcp", all, () => true);
    expect(f.tools).toHaveLength(128);
    expect(f.truncated).toBe(true);
    expect(
      buildDiscoveryFields("s", "mcp", all.slice(0, 128), () => true).truncated,
    ).toBe(false);
  });

  it("description cut to 120 chars on a code-point boundary", () => {
    const f = buildDiscoveryFields(
      "s",
      "service",
      [tool("a", "😀".repeat(300)), tool("b", "x".repeat(300))],
      () => true,
    );
    expect(Array.from(f.tools[0].description)).toHaveLength(120);
    expect(f.tools[0].description).toBe("😀".repeat(120));
    expect(f.tools[1].description).toHaveLength(120);
    expect(f.kind).toBe("service");
  });

  it("stays under the agent log fields cap", () => {
    const all = Array.from({ length: 128 }, (_, i) =>
      tool(`tool_${i}`, "d".repeat(300)),
    );
    const f = buildDiscoveryFields("s", "mcp", all, () => true);
    expect(JSON.stringify(f).length).toBeLessThanOrEqual(8192);
    expect(f.truncated).toBe(true);
    expect(f.tools.length).toBeGreaterThan(0);
    expect(f.event).toBe(TOOLS_DISCOVERED_EVENT);
    for (const t of f.tools) {
      expect(Array.from(t.description).length).toBeLessThanOrEqual(120);
    }
    expect(sanitizeAgentLogFields(f)?.event).toBe(TOOLS_DISCOVERED_EVENT);
  });

  it("small list not truncated by budget", () => {
    const all = [tool("a", "x"), tool("b", "y"), tool("c", "z")];
    const f = buildDiscoveryFields("s", "mcp", all, () => true);
    expect(f.tools).toHaveLength(3);
    expect(f.truncated).toBe(false);
  });
});
