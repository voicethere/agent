import { describe, expect, it } from "vitest";
import type {
  McpToolInfo,
  McpToolSource,
} from "../../../src/llm/mcp/mcp-tool-source.js";
import {
  MAX_RESULT_BYTES,
  MAX_TOOLS,
  ToolRegistry,
} from "../../../src/llm/mcp/tool-registry.js";

function fakeSource(
  name: string,
  tools: McpToolInfo[],
  callResult = "ok",
): McpToolSource {
  return {
    name,
    tools: () => tools,
    callTool: async (tool: string) => ({
      content: `${callResult}:${tool}`,
      isError: false,
    }),
  } as unknown as McpToolSource;
}

function info(name: string): McpToolInfo {
  return { name, description: name, inputSchema: { type: "object" } };
}

const ctx = { timeoutMs: 1_000, sessionId: "s1" };

describe("ToolRegistry", () => {
  it("custom tool name conflicts throw LLM_TOOL_NAME_CONFLICT", () => {
    const reg = new ToolRegistry();
    const tool = {
      name: "dup",
      description: "d",
      inputSchema: {},
      handler: async () => "x",
    };
    reg.addCustomTool(tool);
    let caught: unknown;
    try {
      reg.addCustomTool(tool);
    } catch (e) {
      caught = e;
    }
    expect((caught as { code?: string }).code).toBe("LLM_TOOL_NAME_CONFLICT");
  });

  it("an MCP tool clashing with a custom tool is exposed with the source prefix", async () => {
    const reg = new ToolRegistry();
    reg.addCustomTool({
      name: "echo",
      description: "custom",
      inputSchema: {},
      handler: async () => "custom-result",
    });
    reg.addSource(fakeSource("srv", [info("echo")]));
    const names = reg.list().map((t) => [t.spec.name, t.owner]);
    expect(names).toEqual([
      ["echo", "custom"],
      ["srv__echo", "srv"],
    ]);
    expect(await reg.call("echo", {}, ctx)).toEqual({
      content: "custom-result",
      isError: false,
    });
    expect(await reg.call("srv__echo", {}, ctx)).toEqual({
      content: "ok:echo",
      isError: false,
    });
  });

  it("invalid tool names are sanitized", async () => {
    const reg = new ToolRegistry();
    reg.addSource(fakeSource("srv", [info("a.b c"), info("x".repeat(80))]));
    const names = reg.list().map((t) => t.spec.name);
    expect(names).toEqual(["a_b_c", "x".repeat(64)]);
    expect((await reg.call("a_b_c", {}, ctx)).content).toBe("ok:a.b c");
  });

  it("more than 128 tools are capped", () => {
    const reg = new ToolRegistry();
    const tools = Array.from({ length: 200 }, (_, i) => info(`t${i}`));
    reg.addSource(fakeSource("srv", tools));
    expect(reg.list()).toHaveLength(MAX_TOOLS);
  });

  it("results over 16 KiB are truncated", async () => {
    const reg = new ToolRegistry();
    reg.addCustomTool({
      name: "big",
      description: "d",
      inputSchema: {},
      handler: async () => "é".repeat(MAX_RESULT_BYTES),
    });
    const res = await reg.call("big", {}, ctx);
    expect(res.isError).toBe(false);
    expect(res.content.endsWith("\n[truncated]")).toBe(true);
    const body = res.content.slice(0, -"\n[truncated]".length);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(body).not.toContain("�");
  });
});
