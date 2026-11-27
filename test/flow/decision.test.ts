import { describe, expect, it } from "vitest";
import {
  compileFlow,
  FlowSession,
  validateFlow,
} from "../../src/flow/core/index.js";
import { makeHarness } from "./harness.js";

const model = { provider: "openrouter", model: "m", apiKeySecret: "AGENT_K" };

function decisionDoc(
  assign: Record<string, string | number | boolean>,
  branches: any[],
): any {
  return {
    version: 1,
    start: "s",
    models: { default: model },
    nodes: [
      { id: "s", type: "set", assign, next: "d" },
      { id: "d", type: "decision", branches, default: "other" },
      ...["a", "b", "other"].map((id) => ({
        id,
        type: "speak",
        text: `took ${id}`,
        next: "done",
      })),
      { id: "done", type: "end", reason: "ok" },
    ],
  };
}

async function run(d: any) {
  const h = makeHarness();
  const s = new FlowSession(compileFlow(d), h.effects, {
    sessionId: "s1",
    channel: "voice",
  });
  await s.start();
  const exit = h.traces.find((t) => t.nodeId === "d" && t.phase === "exit");
  return { h, spoken: h.speaks.map((x) => x.text), edge: exit?.edge };
}

const eq = (v: string) => ({ all: [{ var: "x", op: "eq", value: v }] });

describe("decision node", () => {
  it("first matching branch wins", async () => {
    const r = await run(
      decisionDoc({ x: "y" }, [
        { id: "first", rules: eq("y"), next: "a" },
        { id: "second", rules: eq("y"), next: "b" },
      ]),
    );
    expect(r.spoken).toEqual(["took a"]);
    expect(r.edge).toBe("first");
  });

  it("falls to default when nothing matches", async () => {
    const r = await run(
      decisionDoc({ x: "n" }, [{ id: "first", rules: eq("y"), next: "a" }]),
    );
    expect(r.spoken).toEqual(["took other"]);
    expect(r.edge).toBe("default");
  });

  it("regex branch on an llm saveAs variable", async () => {
    const r = await run(
      decisionDoc({ reply: "I want a REFUND" }, [
        {
          id: "refund",
          rules: {
            all: [{ var: "reply", op: "matches", value: "refund", flags: "i" }],
          },
          next: "b",
        },
      ]),
    );
    expect(r.spoken).toEqual(["took b"]);
    expect(r.edge).toBe("refund");
  });

  it("branches on an mcp result", async () => {
    const r = await run(
      decisionDoc({ "lookup.result": "found" }, [
        {
          id: "has",
          rules: { all: [{ var: "lookup.result", op: "exists" }] },
          next: "a",
        },
      ]),
    );
    expect(r.spoken).toEqual(["took a"]);
    expect(r.edge).toBe("has");
  });

  it("rejects a duplicate branch id", () => {
    const res = validateFlow(
      decisionDoc({ x: "y" }, [
        { id: "dup", rules: eq("y"), next: "a" },
        { id: "dup", rules: eq("n"), next: "b" },
      ]),
    );
    expect(res.errors.map((e) => [e.code, e.path])).toContainEqual([
      "FLOW_DUPLICATE_BRANCH_ID",
      "/nodes/1/branches/1/id",
    ]);
  });

  it("rejects branch id default", () => {
    const res = validateFlow(
      decisionDoc({ x: "y" }, [{ id: "default", rules: eq("y"), next: "a" }]),
    );
    expect(res.errors.map((e) => [e.code, e.path])).toContainEqual([
      "FLOW_RESERVED_BRANCH_ID",
      "/nodes/1/branches/0/id",
    ]);
  });

  it("rejects 17 branches", () => {
    const branches = Array.from({ length: 17 }, (_, i) => ({
      id: `b${i}`,
      rules: eq("y"),
      next: "a",
    }));
    const res = validateFlow(decisionDoc({ x: "y" }, branches));
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.path.startsWith("/nodes/1/branches"))).toBe(
      true,
    );
  });

  it("reports an unknown branch target at its path", () => {
    const res = validateFlow(
      decisionDoc({ x: "y" }, [{ id: "g", rules: eq("y"), next: "nope" }]),
    );
    expect(res.errors.map((e) => [e.code, e.path])).toContainEqual([
      "FLOW_UNKNOWN_TARGET",
      "/nodes/1/branches/0/next",
    ]);
  });

  it("a valid decision flow validates", () => {
    const res = validateFlow(
      decisionDoc({ x: "y" }, [
        { id: "g", rules: eq("y"), next: "a" },
        { id: "h", rules: eq("n"), next: "b" },
      ]),
    );
    expect(res.errors).toEqual([]);
  });
});
