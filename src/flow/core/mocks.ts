import type { FlowDocument, FlowNode } from "./types.js";

export type FlowMockHttp =
  | { status: number; headers?: Record<string, string>; body: unknown }
  | { error: "HTTP_TIMEOUT" | "HTTP_NETWORK" };

/** `error` is an error code (e.g. `MCP_TIMEOUT`) that drives the node's `onError`. */
export type FlowMockMcp =
  { result: unknown } | { isError: true; content: string } | { error: string };

export interface FlowMockCase {
  name: string;
  http?: FlowMockHttp;
  mcp?: FlowMockMcp;
  llm?:
    | { text: string; toolCalls?: { name: string; input: unknown }[] }
    | { error: string };
  route?: { path: string } | { error: string };
}

export interface FlowMocks {
  version: 1;
  nodes: Record<string, FlowMockCase[]>;
}

export interface FlowMockIssue {
  code: string;
  message: string;
  nodeId?: string;
  /** JSON Pointer into the mocks document. */
  path: string;
}

export interface FlowMocksValidation {
  ok: boolean;
  mocks?: FlowMocks;
  errors: FlowMockIssue[];
}

const KINDS = ["http", "mcp", "llm", "route"] as const;
type MockKind = (typeof KINDS)[number];

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function kindOf(node: FlowNode): MockKind | undefined {
  return (KINDS as readonly string[]).includes(node.type)
    ? (node.type as MockKind)
    : undefined;
}

/** Checks a parsed `voicethere.flow.mocks.json` against its flow. */
export function validateMocks(
  input: unknown,
  flow: FlowDocument,
): FlowMocksValidation {
  const errors: FlowMockIssue[] = [];
  const add = (code: string, message: string, path: string, nodeId?: string) =>
    errors.push({ code, message, path, ...(nodeId ? { nodeId } : {}) });

  if (!isObj(input)) {
    add("MOCKS_SHAPE", "mocks must be an object", "");
    return { ok: false, errors };
  }
  if (input["version"] !== 1)
    add("MOCKS_VERSION", "mocks version must be 1", "/version");
  const nodesIn = input["nodes"];
  if (!isObj(nodesIn)) {
    add("MOCKS_SHAPE", "nodes must be an object", "/nodes");
    return { ok: false, errors };
  }
  const byId = new Map<string, FlowNode>();
  for (const n of flow.nodes) byId.set(n.id, n);

  for (const [nodeId, cases] of Object.entries(nodesIn)) {
    const base = `/nodes/${nodeId.replace(/~/g, "~0").replace(/\//g, "~1")}`;
    const node = byId.get(nodeId);
    if (!node) {
      add("MOCK_UNKNOWN_NODE", `node ${nodeId} is not in the flow`, base);
      continue;
    }
    const want = kindOf(node);
    if (!want) {
      add(
        "MOCK_KIND_MISMATCH",
        `node ${nodeId} (${node.type}) cannot be mocked`,
        base,
        nodeId,
      );
      continue;
    }
    if (!Array.isArray(cases)) {
      add("MOCKS_SHAPE", "cases must be an array", base, nodeId);
      continue;
    }
    cases.forEach((c: unknown, i) => {
      const cp = `${base}/${i}`;
      if (!isObj(c) || typeof c["name"] !== "string" || c["name"] === "") {
        add("MOCKS_SHAPE", "a case needs a name", cp, nodeId);
        return;
      }
      for (const k of KINDS) {
        if (k !== want && c[k] !== undefined)
          add(
            "MOCK_KIND_MISMATCH",
            `case ${c["name"]} has ${k} data but node ${nodeId} is ${node.type}`,
            `${cp}/${k}`,
            nodeId,
          );
      }
      for (const k of ["mcp", "llm", "route"] as const) {
        const d = c[k];
        if (isObj(d) && d["error"] !== undefined) {
          const e = d["error"];
          if (typeof e !== "string" || e === "")
            add(
              "MOCKS_SHAPE",
              "error must be a non-empty error code",
              `${cp}/${k}/error`,
              nodeId,
            );
        }
      }
      if (
        node.type === "route" &&
        isObj(c["route"]) &&
        c["route"]["error"] === undefined
      ) {
        const p = c["route"]["path"];
        if (
          typeof p !== "string" ||
          (p !== "none" && !node.paths.some((x) => x.id === p))
        )
          add(
            "MOCK_UNKNOWN_PATH",
            `route path is not declared on node ${nodeId}`,
            `${cp}/route/path`,
            nodeId,
          );
      }
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, mocks: input as unknown as FlowMocks, errors };
}
