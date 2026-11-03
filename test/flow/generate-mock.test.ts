import { describe, expect, it } from "vitest";
import {
  generateMock,
  resolvePointer,
  validateFlow,
} from "../../src/flow/core/index.js";

const model = { provider: "openrouter", model: "m", apiKeySecret: "AGENT_K" };

function flow(): any {
  return {
    version: 1,
    start: "call",
    models: { default: model },
    variables: { balance: { type: "number" }, name: { type: "string" } },
    nodes: [
      {
        id: "call",
        type: "http",
        method: "GET",
        url: "https://api.example.com/c",
        map: {
          balance: "/data/balance",
          name: "/data/people/0/name",
        },
        next: "cond",
        onError: "end",
      },
      {
        id: "cond",
        type: "condition",
        rules: { all: [{ var: "balance", op: "gt", value: 0 }] },
        then: "end",
        else: "end",
      },
      { id: "end", type: "end", reason: "done" },
    ],
  };
}

const schema = {
  type: "object",
  properties: {
    kind: { enum: ["a", "b", "c"] },
    fixed: { const: 7 },
    mail: { type: "string", format: "email" },
    at: { type: "string", format: "date-time" },
    link: { type: "string", format: "uri" },
    id: { type: "string", format: "uuid" },
    n: { type: "integer", minimum: 5, maximum: 9 },
    code: { type: "string", minLength: 4, maxLength: 6 },
    ok: { type: "boolean" },
    list: { type: "array", items: { type: "number", minimum: 1, maximum: 2 } },
  },
};

describe("generateMock", () => {
  const v = validateFlow(flow());
  const f = v.flow!;
  const node = f.nodes[0]!;

  it("is deterministic per seed and differs across seeds", () => {
    const a = generateMock(node, { flow: f, seed: 1 });
    const b = generateMock(node, { flow: f, seed: 1 });
    const c = generateMock(node, { flow: f, seed: 2 });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("makes every map pointer resolve, numeric where compared with a number", () => {
    const m = generateMock(node, { flow: f, seed: 3 });
    const body = (m.http as any).body;
    expect(typeof resolvePointer(body, "/data/balance")).toBe("number");
    expect(typeof resolvePointer(body, "/data/people/0/name")).toBe("string");
    expect(Array.isArray(body.data.people)).toBe(true);
  });

  it("builds mcp results from an output schema", () => {
    const m = generateMock(
      { id: "t", type: "mcp", source: "s", tool: "t" } as any,
      { flow: f, seed: 4, outputSchema: schema },
    );
    const r = (m.mcp as any).result;
    expect(["a", "b", "c"]).toContain(r.kind);
    expect(r.fixed).toBe(7);
    expect(r.mail).toMatch(/^[^@]+@[^@]+$/);
    expect(Number.isNaN(Date.parse(r.at))).toBe(false);
    expect(r.link).toMatch(/^https:\/\//);
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.n).toBeGreaterThanOrEqual(5);
    expect(r.n).toBeLessThanOrEqual(9);
    expect(r.code.length).toBeGreaterThanOrEqual(4);
    expect(r.code.length).toBeLessThanOrEqual(6);
    expect(typeof r.ok).toBe("boolean");
    expect(r.list.length).toBeGreaterThan(0);
  });

  it("falls back to a sample, then to an empty result", () => {
    const n = { id: "t", type: "mcp", source: "s", tool: "t" } as any;
    expect(generateMock(n, { flow: f, seed: 1, sample: { a: 1 } }).mcp).toEqual(
      {
        result: { a: 1 },
      },
    );
    expect(generateMock(n, { flow: f, seed: 1 }).mcp).toEqual({ result: {} });
  });

  it("answers llm and route nodes", () => {
    expect(
      generateMock({ id: "x", type: "llm" } as any, { flow: f, seed: 1 }).llm
        ?.text,
    ).toBe("Mock answer for x.");
    expect(
      generateMock(
        { id: "r", type: "route", paths: [{ id: "p1" }, { id: "p2" }] } as any,
        { flow: f, seed: 1 },
      ).route,
    ).toEqual({ path: "p1" });
  });

  it("returns ceil(minimum) when no integer fits the range", () => {
    const n = { id: "t", type: "mcp", source: "s", tool: "t" } as any;
    const r = (
      generateMock(n, {
        flow: f,
        seed: 1,
        outputSchema: { type: "integer", minimum: 1.5, maximum: 1.7 },
      }).mcp as any
    ).result;
    expect(Number.isInteger(r)).toBe(true);
    expect(r).toBe(2);
  });

  it("respects minItems above 3", () => {
    const n = { id: "t", type: "mcp", source: "s", tool: "t" } as any;
    const r = (
      generateMock(n, {
        flow: f,
        seed: 1,
        outputSchema: { type: "array", minItems: 5, items: { type: "string" } },
      }).mcp as any
    ).result;
    expect(r).toHaveLength(5);
  });
});
