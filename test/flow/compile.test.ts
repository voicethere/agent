import { describe, expect, it } from "vitest";
import {
  compileFlow,
  compileValue,
  normalizeUtterance,
  renderValue,
} from "../../src/flow/core/index.js";
import { baseFlow } from "./fixtures.js";

const plain = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    typeof x === "function"
      ? "fn"
      : x instanceof Map
        ? [...x.entries()]
        : x instanceof Set
          ? [...x]
          : x,
  );

describe("compileFlow", () => {
  it("maps node ids to indexes", () => {
    const c = compileFlow(baseFlow());
    expect(c.nodes[c.start]!.id).toBe("greet");
    const ask = c.nodes[c.indexOf.get("ask")!]!;
    expect(ask.type === "listen" && c.nodes[ask.next]!.id).toBe("topic");
    expect(ask.type === "listen" && c.nodes[ask.onNoInput]!.id).toBe(
      "reprompt",
    );
  });

  it("ignores ui: docs differing only in ui compile equal", () => {
    const a = baseFlow();
    const b = baseFlow();
    a.ui = { positions: { greet: { x: 0, y: 0 } } };
    b.ui = { positions: { greet: { x: 99, y: 5 } }, comments: ["x"] };
    expect(plain(compileFlow(a))).toBe(plain(compileFlow(b)));
    expect(plain(compileFlow(a))).toBe(plain(compileFlow(baseFlow())));
  });

  it("resolves model use references", () => {
    const c = compileFlow(baseFlow());
    expect(c.models.classifier).toEqual(c.models.default);
    expect(c.models.classifier!.model).toBe("amazon/nova-micro-v1");
  });

  it("builds route keyword and example sets, lower-cased and normalized", () => {
    const f = baseFlow();
    const route = f.nodes.find((n: any) => n.type === "route");
    route.paths[0].keywords = ["Invoice", " REFUND "];
    route.paths[0].examples = ["Charged   Twice!!", "My Invoice."];
    const c = compileFlow(f);
    const r = c.nodes[c.indexOf.get("topic")!]!;
    if (r.type !== "route") throw new Error("not route");
    expect([...r.paths[0]!.keywords]).toEqual(["invoice", "refund"]);
    expect([...r.paths[0]!.exampleSet]).toEqual([
      "charged twice",
      "my invoice",
    ]);
  });

  it("normalizes utterances", () => {
    expect(normalizeUtterance("  Hello   World?! ")).toBe("hello world");
    expect(normalizeUtterance("yes . !")).toBe("yes .");
    expect(normalizeUtterance("!!!")).toBe("");
    expect(normalizeUtterance("wait! what")).toBe("wait! what");
  });

  it("normalizes long punctuation runs in linear time", () => {
    const s = "!".repeat(200_000) + "x";
    // The old /[.!?]+$/ backtracked for seconds here; a regression hangs and
    // fails on the vitest testTimeout instead of on a wall-clock assertion.
    expect(normalizeUtterance(s)).toBe(s);
  });

  it("applies defaults", () => {
    const c = compileFlow(baseFlow());
    const ask = c.nodes[c.indexOf.get("ask")!]!;
    expect(ask.type === "listen" && ask.timeoutMs).toBe(8000);
    const f = baseFlow();
    f.nodes.find((n: any) => n.id === "ask").timeoutMs = undefined;
    const c2 = compileFlow(f);
    const ask2 = c2.nodes[c2.indexOf.get("ask")!]!;
    expect(ask2.type === "listen" && ask2.timeoutMs).toBe(8000);
  });

  it("compiles and renders nested templates", () => {
    const v = compileValue({ a: "Hi {{n}}", b: [1, "{{n}}"], c: true });
    const out = renderValue(v, (parts) =>
      parts.map((p) => (p.kind === "text" ? p.text : "Ann")).join(""),
    );
    expect(out).toEqual({ a: "Hi Ann", b: [1, "Ann"], c: true });
  });
});
