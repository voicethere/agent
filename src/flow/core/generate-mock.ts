import type { FlowMockCase } from "./mocks.js";
import type {
  FlowDocument,
  FlowNode,
  FlowRule,
  FlowRuleGroup,
} from "./types.js";

export interface GenerateMockOptions {
  flow: FlowDocument;
  seed: number;
  /** The MCP tool's documented `outputSchema`. */
  outputSchema?: unknown;
  /** A recorded or pasted sample response. */
  sample?: unknown;
}

/** Deterministic PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const int = (r: Rng, lo: number, hi: number): number =>
  lo + Math.floor(r() * (hi - lo + 1));
const hex = (r: Rng, n: number): string => {
  let s = "";
  for (let i = 0; i < n; i++) s += int(r, 0, 15).toString(16);
  return s;
};
const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function formatted(format: string, r: Rng): string | undefined {
  switch (format) {
    case "email":
      return `user${hex(r, 4)}@example.com`;
    case "date-time": {
      const ms = Date.UTC(2026, 0, 1) + int(r, 0, 364 * 24 * 3600) * 1000;
      return new Date(ms).toISOString();
    }
    case "date": {
      const ms = Date.UTC(2026, 0, 1) + int(r, 0, 364) * 86400000;
      return new Date(ms).toISOString().slice(0, 10);
    }
    case "uri":
      return `https://example.com/${hex(r, 6)}`;
    case "uuid": {
      const h = hex(r, 32);
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
    }
    default:
      return undefined;
  }
}

function fromSchema(schema: unknown, r: Rng, depth: number): unknown {
  if (!isObj(schema) || depth > 6) return null;
  if (Object.hasOwn(schema, "const")) return schema["const"];
  const en = schema["enum"];
  if (Array.isArray(en) && en.length > 0) return en[int(r, 0, en.length - 1)];
  let type = schema["type"];
  if (Array.isArray(type)) type = type.find((t) => t !== "null") ?? type[0];
  if (type === undefined)
    type = isObj(schema["properties"])
      ? "object"
      : schema["items"] !== undefined
        ? "array"
        : "string";
  switch (type) {
    case "object": {
      const out: Record<string, unknown> = {};
      const props = schema["properties"];
      if (isObj(props))
        for (const [k, v] of Object.entries(props))
          out[k] = fromSchema(v, r, depth + 1);
      return out;
    }
    case "array": {
      const minItems =
        typeof schema["minItems"] === "number" ? schema["minItems"] : 0;
      const maxItems =
        typeof schema["maxItems"] === "number" ? schema["maxItems"] : 3;
      const n = Math.max(minItems, Math.min(3, maxItems));
      return Array.from({ length: n }, () =>
        fromSchema(schema["items"], r, depth + 1),
      );
    }
    case "integer":
    case "number": {
      const lo = typeof schema["minimum"] === "number" ? schema["minimum"] : 0;
      const hi =
        typeof schema["maximum"] === "number"
          ? schema["maximum"]
          : Math.max(lo, 0) + 100;
      if (type === "integer") {
        // No integer in [lo, hi]: documented fallback is ceil(lo).
        if (Math.ceil(lo) > Math.floor(hi)) return Math.ceil(lo);
        return int(r, Math.ceil(lo), Math.floor(hi));
      }
      return Math.round((lo + r() * (hi - lo)) * 100) / 100;
    }
    case "boolean":
      return r() < 0.5;
    case "null":
      return null;
    default: {
      if (typeof schema["format"] === "string") {
        const f = formatted(schema["format"], r);
        if (f !== undefined) return f;
      }
      const minL =
        typeof schema["minLength"] === "number" ? schema["minLength"] : 1;
      const maxL =
        typeof schema["maxLength"] === "number"
          ? schema["maxLength"]
          : Math.max(minL, 12);
      let s = `text-${hex(r, 8)}`;
      while (s.length < minL) s += hex(r, 4);
      return s.slice(0, Math.max(0, maxL));
    }
  }
}

function numericVars(flow: FlowDocument): Set<string> {
  const out = new Set<string>();
  const rule = (x: FlowRule | FlowRuleGroup): void => {
    if ("all" in x) x.all.forEach(rule);
    else if ("any" in x) x.any.forEach(rule);
    else if (
      ["gt", "gte", "lt", "lte"].includes(x.op) ||
      (["eq", "ne"].includes(x.op) && typeof x.value === "number")
    )
      out.add(x.var);
  };
  for (const n of flow.nodes) if (n.type === "condition") rule(n.rules);
  return out;
}

function setPointer(
  root: { v: unknown },
  pointer: string,
  leaf: unknown,
): void {
  if (pointer === "") {
    root.v = leaf;
    return;
  }
  const tokens = pointer
    .slice(1)
    .split("/")
    .map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
  const isIdx = (t: string): boolean => /^(0|[1-9]\d*)$/.test(t);
  if (root.v === null || typeof root.v !== "object")
    root.v = isIdx(tokens[0]!) ? [] : Object.create(null);
  let cur = root.v as Record<string, unknown>;
  tokens.forEach((t, i) => {
    if (i === tokens.length - 1) {
      cur[t] = leaf;
      return;
    }
    let next = cur[t];
    if (next === null || typeof next !== "object")
      next = isIdx(tokens[i + 1]!) ? [] : Object.create(null);
    cur[t] = next;
    cur = next as Record<string, unknown>;
  });
}

function plain(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(plain);
  if (isObj(v)) {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = plain(x);
    return o;
  }
  return v;
}

/**
 * Deterministic mock case for one node. The same seed gives the same data.
 * No LLM is involved.
 */
export function generateMock(
  node: FlowNode,
  opts: GenerateMockOptions,
): FlowMockCase {
  const r = mulberry32(opts.seed);
  switch (node.type) {
    case "mcp": {
      if (opts.outputSchema !== undefined)
        return {
          name: "generated",
          mcp: { result: fromSchema(opts.outputSchema, r, 0) },
        };
      return {
        name: "generated",
        mcp: { result: opts.sample !== undefined ? opts.sample : {} },
      };
    }
    case "http": {
      if (opts.sample !== undefined)
        return { name: "generated", http: { status: 200, body: opts.sample } };
      const nums = numericVars(opts.flow);
      const root: { v: unknown } = { v: undefined };
      for (const [variable, pointer] of Object.entries(node.map ?? {})) {
        const leaf = nums.has(variable)
          ? int(r, 1, 100)
          : `${variable}-${hex(r, 6)}`;
        setPointer(root, pointer, leaf);
      }
      return {
        name: "generated",
        http: { status: 200, body: plain(root.v ?? {}) },
      };
    }
    case "llm":
      return {
        name: "generated",
        llm: { text: `Mock answer for ${node.id}.` },
      };
    case "route":
      return { name: "generated", route: { path: node.paths[0]!.id } };
    default:
      throw new Error(`node ${node.id} (${node.type}) has nothing to mock`);
  }
}
