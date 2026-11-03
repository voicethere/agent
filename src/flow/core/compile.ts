import { compileRuleGroup, type FlowLookup } from "./conditions.js";
import { parseTemplate, type TemplatePart } from "./template.js";
import type {
  FlowDocument,
  FlowHttpHeader,
  FlowModel,
  FlowNode,
} from "./types.js";

export type CompiledValue =
  | { kind: "tpl"; parts: TemplatePart[] }
  | { kind: "array"; items: CompiledValue[] }
  | { kind: "object"; entries: [string, CompiledValue][] }
  | { kind: "literal"; value: unknown };

export function compileValue(v: unknown): CompiledValue {
  if (typeof v === "string") return { kind: "tpl", parts: parseTemplate(v) };
  if (Array.isArray(v)) return { kind: "array", items: v.map(compileValue) };
  if (v && typeof v === "object") {
    return {
      kind: "object",
      entries: Object.entries(v as Record<string, unknown>).map(([k, x]) => [
        k,
        compileValue(x),
      ]),
    };
  }
  return { kind: "literal", value: v };
}

export function renderValue(
  v: CompiledValue,
  render: (parts: TemplatePart[]) => string,
): unknown {
  switch (v.kind) {
    case "tpl":
      return render(v.parts);
    case "array":
      return v.items.map((i) => renderValue(i, render));
    case "object":
      return Object.fromEntries(
        v.entries.map(([k, x]) => [k, renderValue(x, render)]),
      );
    default:
      return v.value;
  }
}

/** Lower-case, trim, collapse spaces, strip trailing `.!?`. */
export function normalizeUtterance(s: string): string {
  const t = s.toLowerCase().replace(/\s+/g, " ").trim();
  // Linear scan instead of /[.!?]+$/: that regex is quadratic on long runs of
  // punctuation that do not end the string, and this runs on caller text.
  let end = t.length;
  while (end > 0 && ".!?".includes(t[end - 1]!)) end--;
  return t.slice(0, end).trim();
}

export interface CompiledRoutePath {
  id: string;
  examples: string[];
  exampleSet: Set<string>;
  keywords: Set<string>;
  next: number;
}

export type CompiledHeader =
  | { kind: "tpl"; parts: TemplatePart[] }
  | { kind: "secret"; secret: string; prefix: string };

export type CompiledNode =
  | {
      type: "speak";
      id: string;
      text: TemplatePart[];
      interruptible: boolean;
      next: number;
    }
  | {
      type: "listen";
      id: string;
      timeoutMs: number;
      next: number;
      onNoInput: number;
    }
  | { type: "wait"; id: string; ms: number; next: number }
  | {
      type: "route";
      id: string;
      input: TemplatePart[];
      paths: CompiledRoutePath[];
      onNone: number;
      onError: number;
      timeoutMs: number;
      model: string | undefined;
      historyTurns: number;
    }
  | {
      type: "condition";
      id: string;
      test: (lookup: FlowLookup) => boolean;
      then: number;
      else: number;
    }
  | {
      type: "set";
      id: string;
      assign: { name: string; value: TemplatePart[] | number | boolean }[];
      next: number;
    }
  | {
      type: "http";
      id: string;
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      url: TemplatePart[];
      headers: [string, CompiledHeader][];
      body: CompiledValue | undefined;
      map: [string, string][];
      timeoutMs: number;
      next: number;
      onError: number;
    }
  | {
      type: "mcp";
      id: string;
      source: string;
      tool: string;
      args: CompiledValue | undefined;
      map: [string, string][];
      timeoutMs: number;
      next: number;
      onError: number;
    }
  | {
      type: "llm";
      id: string;
      instructions: TemplatePart[];
      send: "conversation" | "message";
      message: TemplatePart[] | undefined;
      historyTurns: number | undefined;
      model: string | undefined;
      speak: boolean;
      saveAs: string | undefined;
      tools: "none" | "all" | string[];
      maxRounds: number;
      filler: { text: string; afterMs: number } | undefined;
      next: number;
      onError: number;
    }
  | {
      type: "end";
      id: string;
      reason: string;
      text: TemplatePart[] | undefined;
    };

export interface CompiledFlow {
  nodes: CompiledNode[];
  start: number;
  indexOf: Map<string, number>;
  models: Record<string, FlowModel>;
  defaults: Record<string, unknown>;
}

function compileHeader(h: FlowHttpHeader): CompiledHeader {
  if (typeof h === "string") return { kind: "tpl", parts: parseTemplate(h) };
  return { kind: "secret", secret: h.secret, prefix: h.prefix ?? "" };
}

function resolveModels(flow: FlowDocument): Record<string, FlowModel> {
  const out: Record<string, FlowModel> = {};
  for (const name of Object.keys(flow.models)) {
    let entry = flow.models[name];
    const seen = new Set<string>([name]);
    while (entry && "use" in entry) {
      if (seen.has(entry.use)) throw new Error(`model cycle at "${entry.use}"`);
      seen.add(entry.use);
      entry = flow.models[entry.use];
    }
    if (!entry) throw new Error(`model "${name}" resolves to nothing`);
    out[name] = entry as FlowModel;
  }
  return out;
}

/** Compiles a validated flow. `ui` is ignored. */
export function compileFlow(flow: FlowDocument): CompiledFlow {
  const indexOf = new Map<string, number>();
  flow.nodes.forEach((n, i) => indexOf.set(n.id, i));
  const ix = (id: string): number => {
    const i = indexOf.get(id);
    if (i === undefined) throw new Error(`unknown node "${id}"`);
    return i;
  };
  const pairs = (m: Record<string, string> | undefined): [string, string][] =>
    m ? Object.entries(m) : [];

  const compileNode = (n: FlowNode): CompiledNode => {
    switch (n.type) {
      case "speak":
        return {
          type: "speak",
          id: n.id,
          text: parseTemplate(n.text),
          interruptible: n.interruptible ?? true,
          next: ix(n.next),
        };
      case "listen":
        return {
          type: "listen",
          id: n.id,
          timeoutMs: n.timeoutMs ?? 8000,
          next: ix(n.next),
          onNoInput: ix(n.onNoInput),
        };
      case "wait":
        return { type: "wait", id: n.id, ms: n.ms, next: ix(n.next) };
      case "route":
        return {
          type: "route",
          id: n.id,
          input: parseTemplate(n.input ?? "{{last.transcript}}"),
          paths: n.paths.map((p) => ({
            id: p.id,
            examples: p.examples,
            exampleSet: new Set(p.examples.map(normalizeUtterance)),
            keywords: new Set(
              (p.keywords ?? []).map((k) => k.trim().toLowerCase()),
            ),
            next: ix(p.next),
          })),
          onNone: ix(n.onNone),
          onError: ix(n.onError),
          timeoutMs: n.timeoutMs ?? 3000,
          model: n.model,
          historyTurns: n.historyTurns ?? 0,
        };
      case "condition":
        return {
          type: "condition",
          id: n.id,
          test: compileRuleGroup(n.rules),
          then: ix(n.then),
          else: ix(n.else),
        };
      case "set":
        return {
          type: "set",
          id: n.id,
          assign: Object.entries(n.assign).map(([name, v]) => ({
            name,
            value: typeof v === "string" ? parseTemplate(v) : v,
          })),
          next: ix(n.next),
        };
      case "http":
        return {
          type: "http",
          id: n.id,
          method: n.method,
          url: parseTemplate(n.url),
          headers: Object.entries(n.headers ?? {}).map(([k, h]) => [
            k,
            compileHeader(h),
          ]),
          body: n.body === undefined ? undefined : compileValue(n.body),
          map: pairs(n.map),
          timeoutMs: n.timeoutMs ?? 5000,
          next: ix(n.next),
          onError: ix(n.onError),
        };
      case "mcp":
        return {
          type: "mcp",
          id: n.id,
          source: n.source,
          tool: n.tool,
          args: n.args === undefined ? undefined : compileValue(n.args),
          map: pairs(n.map),
          timeoutMs: n.timeoutMs ?? 15000,
          next: ix(n.next),
          onError: ix(n.onError),
        };
      case "llm":
        return {
          type: "llm",
          id: n.id,
          instructions: parseTemplate(n.instructions),
          send: n.send,
          message:
            n.message === undefined ? undefined : parseTemplate(n.message),
          historyTurns: n.historyTurns,
          model: n.model,
          speak: n.speak ?? false,
          saveAs: n.saveAs,
          tools: n.tools ?? "none",
          maxRounds: n.maxRounds ?? 5,
          filler: n.filler,
          next: ix(n.next),
          onError: ix(n.onError),
        };
      case "end":
        return {
          type: "end",
          id: n.id,
          reason: n.reason,
          text: n.text === undefined ? undefined : parseTemplate(n.text),
        };
    }
  };

  const defaults: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flow.variables ?? {})) {
    if (v.default !== undefined) defaults[k] = v.default;
  }

  return {
    nodes: flow.nodes.map(compileNode),
    start: ix(flow.start),
    indexOf,
    models: resolveModels(flow),
    defaults,
  };
}
