import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileFlow, FlowSession } from "../../src/flow/core/index.js";
import { createNodeEffects } from "../../src/flow/effects-node.js";
import { McpToolSource } from "../../src/llm/mcp/mcp-tool-source.js";
import { ToolRegistry } from "../../src/llm/mcp/tool-registry.js";
import { installAgentIpc } from "../helpers/agent-ipc.js";
import {
  startTestMcpServer,
  type TestMcpServer,
} from "../llm/mcp/mcp-test-server.js";

const model = { provider: "openrouter", model: "m", apiKeySecret: "AGENT_K" };

let mcp: TestMcpServer;
let source: McpToolSource;
let registry: ToolRegistry;
let restoreIpc: () => void = () => {};

beforeAll(async () => {
  restoreIpc = installAgentIpc().restore;
  mcp = await startTestMcpServer();
  source = new McpToolSource({
    name: "crm",
    url: mcp.url,
    headers: { "x-test-token": "tok" },
  });
  registry = new ToolRegistry();
  registry.addSource(source);
  source.start();
  expect(await source.ready(5000)).toBe(true);
});

afterAll(async () => {
  restoreIpc();
  await mcp.stop();
});

function flow(tool: string, args: unknown, extra: any = {}): any {
  return {
    version: 1,
    start: "call",
    models: { default: model },
    tools: { toolSources: [{ kind: "mcp", name: "crm", url: mcp.url }] },
    nodes: [
      {
        id: "call",
        type: "mcp",
        source: "crm",
        tool,
        args,
        next: "ok",
        onError: "bad",
        ...extra,
      },
      { id: "ok", type: "end", reason: "ok" },
      { id: "bad", type: "end", reason: "bad" },
    ],
  };
}

async function run(doc: any) {
  const logs: { message: string; fields: Record<string, unknown> }[] = [];
  const ends: string[] = [];
  const effects = createNodeEffects({
    sessionId: "s1",
    env: {},
    providerFor: () => {
      throw new Error("unused");
    },
    registry,
    log: (_l, message, fields) => logs.push({ message, fields }),
  });
  effects.end = (reason) => ends.push(reason);
  const s = new FlowSession(compileFlow(doc), effects, {
    sessionId: "s1",
    channel: "voice",
  });
  await s.start();
  return { s, ends, logs };
}

describe("mcp node against the MCP test server", () => {
  it("stores the tool content as <id>.result", async () => {
    const r = await run(flow("echo", { text: "hello" }));
    expect(r.s.variables["call.result"]).toBe("hello");
    expect(r.ends).toEqual(["ok"]);
  });

  it("maps a JSON result", async () => {
    // the secret tool returns the x-test-token header as plain text; echo a JSON string instead
    const r = await run(
      flow("echo", { text: '{"word":"plum"}' }, { map: { word: "/word" } }),
    );
    expect(r.s.variables["word"]).toBe("plum");
    expect(r.ends).toEqual(["ok"]);
  });

  it("isError from the server -> MCP_TOOL_ERROR and onError", async () => {
    const r = await run(flow("echo", {}));
    expect(r.s.variables["error.call"]).toBe("MCP_TOOL_ERROR");
    expect(r.ends).toEqual(["bad"]);
  });

  it("a tool that is not offered is MCP_TOOL_ERROR", async () => {
    const r = await run(flow("nope", {}));
    expect(r.s.variables["error.call"]).toBe("MCP_TOOL_ERROR");
  });

  it("a slow tool hits the node timeout -> MCP_TIMEOUT", async () => {
    const r = await run(flow("slow", {}, { timeoutMs: 200 }));
    expect(r.s.variables["error.call"]).toBe("MCP_TIMEOUT");
    expect(r.ends).toEqual(["bad"]);
  });
});
