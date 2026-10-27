import { describe, expect, it } from "vitest";
import { validateLlmAgentConfig } from "../../../src/llm/agent/config.js";
import {
  TOOL_CALL_EVENT,
  buildToolCallFields,
} from "../../../src/llm/agent/tool-call-log.js";
import type { ToolCallFields } from "../../../src/llm/agent/tool-call-log.js";
import type { McpToolSource } from "../../../src/llm/mcp/mcp-tool-source.js";
import { ToolRegistry } from "../../../src/llm/mcp/tool-registry.js";
import {
  AGENT_LOG_FIELDS_MAX_CHARS,
  sanitizeAgentLogFields,
} from "../../../src/runtime.js";

const SECRET = "AGENT-SECRET-VALUE-1";
const ctx = { timeoutMs: 1_000, sessionId: "s1", turnId: "t1", callId: "c1" };

function source(name: string, kind: "mcp" | "service", content: string) {
  return {
    name,
    kind,
    tools: () => [{ name: "lookup", description: "d", inputSchema: {} }],
    callTool: async () => ({ content, isError: false }),
  } as unknown as McpToolSource;
}

function make(mode: "full" | "redacted" | "off" = "redacted") {
  const lines: ToolCallFields[] = [];
  let t = 1_000;
  const reg = new ToolRegistry({
    toolCallLog: {
      mode,
      secretValues: [SECRET],
      emit: (f) => lines.push(f),
      now: () => (t += 5),
    },
  });
  return { reg, lines };
}

describe("llm.tool.call log line", () => {
  it("writes one line per call for mcp, service and custom tools", async () => {
    const { reg, lines } = make();
    reg.addSource(source("crm", "mcp", "ok"));
    reg.addSource(source("svc", "service", "ok"));
    reg.addCustomTool({
      name: "mine",
      description: "d",
      inputSchema: {},
      handler: async () => "done",
    });
    await reg.call("lookup", { q: 1 }, ctx);
    await reg.call("svc__lookup", { q: 2 }, ctx);
    await reg.call("mine", {}, ctx);
    expect(lines.map((l) => [l.kind, l.source, l.tool])).toEqual([
      ["mcp", "crm", "lookup"],
      ["service", "svc", "svc__lookup"],
      ["custom", "custom", "mine"],
    ]);
    expect(lines.every((l) => l.event === TOOL_CALL_EVENT)).toBe(true);
    expect(lines[0]).toMatchObject({ turnId: "t1", callId: "c1" });
  });

  it("logs an error call with isError and the redacted error text", async () => {
    const { reg, lines } = make();
    reg.addCustomTool({
      name: "boom",
      description: "d",
      inputSchema: {},
      handler: async () => {
        throw new Error(`failed for a@b.com with ${SECRET}`);
      },
    });
    await reg.call("boom", {}, ctx);
    expect(lines).toHaveLength(1);
    expect(lines[0].isError).toBe(true);
    expect(lines[0].output).toBe(
      "failed for [redacted:email] with [redacted:secret]",
    );
  });

  it("emits with the call's sessionId", async () => {
    const ids: string[] = [];
    const reg = new ToolRegistry({
      toolCallLog: {
        mode: "redacted",
        secretValues: [],
        emit: (_f, sid) => ids.push(sid),
      },
    });
    reg.addSource(source("crm", "mcp", "ok"));
    await reg.call("lookup", {}, ctx);
    expect(ids).toEqual(["s1"]);
  });

  it("unknown tool writes one error line with kind unknown", async () => {
    const { reg, lines } = make();
    const r = await reg.call("ghost", { a: 1 }, ctx);
    expect(r.isError).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      kind: "unknown",
      source: "",
      isError: true,
      tool: "ghost",
      output: "tool ghost is not available",
    });
  });

  it("writes nothing when mode is off", async () => {
    const { reg, lines } = make("off");
    reg.addSource(source("crm", "mcp", "ok"));
    await reg.call("lookup", {}, ctx);
    expect(lines).toHaveLength(0);
  });

  it("redacts input and output, and startedAt is before endedAt", async () => {
    const { reg, lines } = make();
    reg.addSource(source("crm", "mcp", `{"email":"a@b.com","n":${12345}}`));
    await reg.call("lookup", { token: "abc", note: SECRET }, ctx);
    const l = lines[0];
    expect(l.input).not.toContain(SECRET);
    expect(l.input).toContain("[redacted]");
    expect(l.output).toContain("[redacted:email]");
    expect(l.output).toContain("12345");
    expect(Date.parse(l.startedAt)).toBeLessThan(Date.parse(l.endedAt));
    expect(l.redaction).toBe("redacted");
  });

  it("full mode still removes secret values", async () => {
    const { reg, lines } = make("full");
    reg.addSource(source("crm", "mcp", `x a@b.com ${SECRET}`));
    await reg.call("lookup", {}, ctx);
    expect(lines[0].output).toBe("x a@b.com [redacted:secret]");
  });

  it("cuts input and output to 2048 characters and lists them in truncated", () => {
    const f = buildToolCallFields({
      turnId: "t",
      callId: "c",
      tool: "x",
      source: "custom",
      kind: "custom",
      startedAt: 1,
      endedAt: 2,
      input: "i".repeat(5000),
      output: "o".repeat(5000),
      isError: false,
      mode: "redacted",
    });
    expect(f.input.length).toBe(2048);
    expect(f.output.length).toBe(2048);
    expect(f.truncated).toEqual(["input", "output"]);
  });

  it("keeps the fields under the cap and intact after sanitizeAgentLogFields", () => {
    const f = buildToolCallFields({
      turnId: "t",
      callId: "c",
      tool: "x",
      source: "custom",
      kind: "custom",
      startedAt: 1,
      endedAt: 2,
      input: '"'.repeat(5000),
      output: '"'.repeat(5000),
      isError: false,
      mode: "redacted",
    });
    expect(JSON.stringify(f).length).toBeLessThan(AGENT_LOG_FIELDS_MAX_CHARS);
    expect(sanitizeAgentLogFields({ ...f })?.event).toBe(TOOL_CALL_EVENT);
  });
});

describe("toolCallLogs config", () => {
  const base = {
    version: 1,
    provider: "openai",
    apiKeySecret: "AGENT_OPENAI_API_KEY",
  };
  it("accepts full, redacted and off", () => {
    for (const v of ["full", "redacted", "off"]) {
      const r = validateLlmAgentConfig({ ...base, toolCallLogs: v });
      expect(r.ok && r.config.toolCallLogs).toBe(v);
    }
  });
  it('rejects "yes" with a path', () => {
    const r = validateLlmAgentConfig({ ...base, toolCallLogs: "yes" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].path).toBe("toolCallLogs");
  });
});
