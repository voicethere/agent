import { isPrivateHostLiteral } from "./host.js";
import {
  FLOW_DOC_SHELL_SCHEMA,
  FLOW_JSON_SCHEMA,
  FLOW_NODE_SCHEMAS,
  type JsonSchema,
} from "./schema.js";
import { parseTemplate, templateVars } from "./template.js";
import type {
  FlowDocument,
  FlowIssue,
  FlowNode,
  FlowValidationContext,
  FlowValidationResult,
} from "./types.js";

type Rec = Record<string, unknown>;

const isObj = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const esc = (s: string): string => s.replace(/~/g, "~0").replace(/\//g, "~1");

const BUILTINS = new Set([
  "last.transcript",
  "last.language",
  "last.utteranceId",
  "session.id",
  "session.channel",
]);

const DEFS = (FLOW_JSON_SCHEMA as { $defs: Record<string, JsonSchema> }).$defs;

/** Checks a value against the JSON Schema subset used by the flow schema. */
function checkSchema(
  schema: JsonSchema,
  value: unknown,
  path: string,
  report: (path: string, message: string) => void,
): void {
  const ref = schema.$ref;
  if (typeof ref === "string") {
    const def = DEFS[ref.replace("#/$defs/", "")];
    if (def) checkSchema(def, value, path, report);
    return;
  }
  const oneOf = schema.oneOf as JsonSchema[] | undefined;
  if (oneOf) {
    const ok = oneOf.some((s) => {
      let bad = false;
      checkSchema(s, value, path, () => {
        bad = true;
      });
      return !bad;
    });
    if (!ok) report(path, "does not match any allowed shape");
    return;
  }
  if ("const" in schema && value !== schema.const) {
    report(path, `must be ${JSON.stringify(schema.const)}`);
    return;
  }
  const en = schema.enum as unknown[] | undefined;
  if (en && !en.includes(value)) {
    report(
      path,
      `must be one of ${en.map((e) => JSON.stringify(e)).join(", ")}`,
    );
    return;
  }
  const t = schema.type;
  if (t === "string") {
    if (typeof value !== "string") return report(path, "must be a string");
    const max = schema.maxLength as number | undefined;
    if (max !== undefined && value.length > max) {
      return report(path, `must be at most ${max} characters`);
    }
    const pat = schema.pattern as string | undefined;
    if (pat && !new RegExp(pat).test(value)) {
      return report(path, `must match ${pat}`);
    }
  } else if (t === "integer" || t === "number") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (t === "integer" && !Number.isInteger(value))
    ) {
      return report(
        path,
        `must be ${t === "integer" ? "an integer" : "a number"}`,
      );
    }
    const min = schema.minimum as number | undefined;
    const max = schema.maximum as number | undefined;
    if (min !== undefined && value < min)
      return report(path, `must be >= ${min}`);
    if (max !== undefined && value > max)
      return report(path, `must be <= ${max}`);
  } else if (t === "boolean") {
    if (typeof value !== "boolean") return report(path, "must be a boolean");
  } else if (t === "array") {
    if (!Array.isArray(value)) return report(path, "must be an array");
    const max = schema.maxItems as number | undefined;
    if (max !== undefined && value.length > max) {
      report(path, `must have at most ${max} items`);
    }
    const items = schema.items as JsonSchema | undefined;
    if (items) {
      value.forEach((v, i) => checkSchema(items, v, `${path}/${i}`, report));
    }
  } else if (t === "object") {
    if (!isObj(value)) return report(path, "must be an object");
    const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
    const req = (schema.required ?? []) as string[];
    for (const k of req) {
      if (!(k in value)) report(`${path}/${esc(k)}`, "is required");
    }
    const extra = schema.additionalProperties;
    for (const [k, v] of Object.entries(value)) {
      const p = `${path}/${esc(k)}`;
      if (props[k]) checkSchema(props[k], v, p, report);
      else if (extra === false) report(p, "is not allowed here");
      else if (isObj(extra)) checkSchema(extra, v, p, report);
    }
  }
}

function targetsOf(n: FlowNode, i: number): { path: string; target: string }[] {
  const b = `/nodes/${i}`;
  const out: { path: string; target: string }[] = [];
  const add = (key: string, v: unknown): void => {
    if (typeof v === "string") out.push({ path: `${b}/${key}`, target: v });
  };
  switch (n.type) {
    case "speak":
    case "set":
    case "wait":
      add("next", n.next);
      break;
    case "listen":
      add("next", n.next);
      add("onNoInput", n.onNoInput);
      break;
    case "http":
    case "mcp":
    case "llm":
      add("next", n.next);
      add("onError", n.onError);
      break;
    case "condition":
      add("then", n.then);
      add("else", n.else);
      break;
    case "route":
      n.paths.forEach((p, j) => add(`paths/${j}/next`, p.next));
      add("onNone", n.onNone);
      add("onError", n.onError);
      break;
    case "end":
      break;
  }
  return out;
}

function deepStrings(
  v: unknown,
  path: string,
  cb: (path: string, s: string) => void,
): void {
  if (typeof v === "string") cb(path, v);
  else if (Array.isArray(v))
    v.forEach((x, i) => deepStrings(x, `${path}/${i}`, cb));
  else if (isObj(v)) {
    for (const [k, x] of Object.entries(v))
      deepStrings(x, `${path}/${esc(k)}`, cb);
  }
}

function templatesOf(
  n: FlowNode,
  i: number,
  cb: (path: string, s: string) => void,
): void {
  const b = `/nodes/${i}`;
  switch (n.type) {
    case "speak":
      cb(`${b}/text`, n.text);
      break;
    case "route":
      cb(`${b}/input`, n.input ?? "{{last.transcript}}");
      break;
    case "set":
      for (const [k, v] of Object.entries(n.assign)) {
        if (typeof v === "string") cb(`${b}/assign/${esc(k)}`, v);
      }
      break;
    case "http":
      cb(`${b}/url`, n.url);
      for (const [k, v] of Object.entries(n.headers ?? {})) {
        if (typeof v === "string") cb(`${b}/headers/${esc(k)}`, v);
      }
      deepStrings(n.body, `${b}/body`, cb);
      break;
    case "mcp":
      deepStrings(n.args, `${b}/args`, cb);
      break;
    case "llm":
      cb(`${b}/instructions`, n.instructions);
      if (n.message !== undefined) cb(`${b}/message`, n.message);
      if (n.filler) cb(`${b}/filler/text`, n.filler.text);
      break;
    case "end":
      if (n.text !== undefined) cb(`${b}/text`, n.text);
      break;
    default:
      break;
  }
}

/** Returns the issue code for a URL, or null when it is acceptable. */
function urlProblem(url: string): { code: string; message: string } | null {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/.exec(url);
  if (!m || m[1]!.toLowerCase() !== "https") {
    return {
      code: "FLOW_URL_NOT_HTTPS",
      message: "URL must start with https://",
    };
  }
  const authority = m[2]!;
  if (authority.includes("{{")) {
    return {
      code: "FLOW_URL_TEMPLATED_HOST",
      message: "The host and port of a URL cannot contain {{variables}}",
    };
  }
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return {
      code: "FLOW_URL_NOT_HTTPS",
      message: "URL is not a valid https URL",
    };
  }
  if (isPrivateHostLiteral(host)) {
    return {
      code: "FLOW_URL_PRIVATE_HOST",
      message: `Host "${host}" is private or local`,
    };
  }
  return null;
}

/** Strongly connected components (Tarjan). */
function sccs(adj: number[][]): number[][] {
  const n = adj.length;
  const index = new Array<number>(n).fill(-1);
  const low = new Array<number>(n).fill(0);
  const on = new Array<boolean>(n).fill(false);
  const stack: number[] = [];
  const out: number[][] = [];
  let counter = 0;
  const visit = (v: number): void => {
    index[v] = low[v] = counter++;
    stack.push(v);
    on[v] = true;
    for (const w of adj[v]!) {
      if (index[w] === -1) {
        visit(w);
        low[v] = Math.min(low[v]!, low[w]!);
      } else if (on[w]) low[v] = Math.min(low[v]!, index[w]!);
    }
    if (low[v] === index[v]) {
      const comp: number[] = [];
      let w: number;
      do {
        w = stack.pop()!;
        on[w] = false;
        comp.push(w);
      } while (w !== v);
      out.push(comp);
    }
  };
  for (let v = 0; v < n; v++) if (index[v] === -1) visit(v);
  return out;
}

export function validateFlow(
  input: unknown,
  ctx?: FlowValidationContext,
): FlowValidationResult {
  const errors: FlowIssue[] = [];
  const warnings: FlowIssue[] = [];
  const rawNodes: unknown[] =
    isObj(input) && Array.isArray(input.nodes) ? input.nodes : [];
  const nodeIdAt = (path: string): string | undefined => {
    const m = /^\/nodes\/(\d+)(\/|$)/.exec(path);
    if (!m) return undefined;
    const n = rawNodes[Number(m[1])];
    return isObj(n) && typeof n.id === "string" ? n.id : undefined;
  };
  const issue = (
    list: FlowIssue[],
    code: string,
    message: string,
    path: string,
    nodeId?: string,
  ): void => {
    const id = nodeId ?? nodeIdAt(path);
    list.push(
      id === undefined
        ? { code, message, path }
        : { code, message, path, nodeId: id },
    );
  };
  const err = (
    code: string,
    message: string,
    path: string,
    nodeId?: string,
  ): void => issue(errors, code, message, path, nodeId);
  const finish = (): FlowValidationResult => ({
    ok: errors.length === 0,
    ...(errors.length === 0 ? { flow: input as FlowDocument } : {}),
    errors,
    warnings,
  });

  if (!isObj(input)) {
    err("FLOW_SCHEMA", "Flow must be a JSON object", "");
    return finish();
  }
  const version = input.version;
  if (
    version === undefined ||
    (typeof version === "number" && Number.isInteger(version) && version > 1)
  ) {
    err(
      "FLOW_VERSION_UNSUPPORTED",
      version === undefined
        ? "Flow has no version"
        : `Flow version ${String(version)} is newer than this runtime supports (1)`,
      "/version",
    );
    return finish();
  }

  const shape = (path: string, message: string): void =>
    err("FLOW_SCHEMA", message, path);
  checkSchema(FLOW_DOC_SHELL_SCHEMA, input, "", shape);
  rawNodes.forEach((n, i) => {
    const p = `/nodes/${i}`;
    if (!isObj(n)) return shape(p, "must be an object");
    const schema =
      typeof n.type === "string" ? FLOW_NODE_SCHEMAS[n.type] : undefined;
    if (!schema) return shape(`${p}/type`, "must be a known node type");
    checkSchema(schema, n, p, shape);
  });
  if (errors.length > 0) return finish();

  const flow = input as unknown as FlowDocument;
  const nodes = flow.nodes;

  // ids, start
  const byId = new Map<string, number>();
  nodes.forEach((n, i) => {
    if (byId.has(n.id)) {
      err(
        "FLOW_DUPLICATE_ID",
        `Duplicate node id "${n.id}"`,
        `/nodes/${i}/id`,
        n.id,
      );
    } else byId.set(n.id, i);
  });
  if (!byId.has(flow.start)) {
    err(
      "FLOW_START_MISSING",
      `Start node "${flow.start}" does not exist`,
      "/start",
    );
  }

  // targets and graph
  const adj: number[][] = nodes.map(() => []);
  nodes.forEach((n, i) => {
    for (const t of targetsOf(n, i)) {
      const to = byId.get(t.target);
      if (to === undefined) {
        err(
          "FLOW_UNKNOWN_TARGET",
          `Node "${t.target}" does not exist`,
          t.path,
          n.id,
        );
      } else adj[i]!.push(to);
    }
  });
  const startIdx = byId.get(flow.start);
  if (startIdx !== undefined) {
    const seen = new Array<boolean>(nodes.length).fill(false);
    const queue = [startIdx];
    seen[startIdx] = true;
    while (queue.length > 0) {
      for (const w of adj[queue.shift()!]!) {
        if (!seen[w]) {
          seen[w] = true;
          queue.push(w);
        }
      }
    }
    nodes.forEach((n, i) => {
      if (!seen[i]) {
        err(
          "FLOW_UNREACHABLE",
          `Node "${n.id}" cannot be reached from start`,
          `/nodes/${i}`,
          n.id,
        );
      }
    });
  }
  for (const comp of sccs(adj)) {
    const cyclic = comp.length > 1 || adj[comp[0]!]!.includes(comp[0]!);
    if (!cyclic) continue;
    if (
      comp.some((i) => nodes[i]!.type === "listen" || nodes[i]!.type === "wait")
    )
      continue;
    const first = Math.min(...comp);
    err(
      "FLOW_BUSY_LOOP",
      `Nodes ${comp.map((i) => `"${nodes[i]!.id}"`).join(", ")} loop without a listen or wait node`,
      `/nodes/${first}`,
      nodes[first]!.id,
    );
  }

  // routes
  nodes.forEach((n, i) => {
    if (n.type !== "route") return;
    if (n.paths.length === 0) {
      err(
        "FLOW_ROUTE_NO_PATHS",
        "Route needs at least one path",
        `/nodes/${i}/paths`,
        n.id,
      );
    }
    const ids = new Set<string>();
    n.paths.forEach((p, j) => {
      const pp = `/nodes/${i}/paths/${j}`;
      if (p.examples.length === 0) {
        err(
          "FLOW_ROUTE_NO_EXAMPLES",
          `Path "${p.id}" needs at least one example`,
          `${pp}/examples`,
          n.id,
        );
      }
      if (p.id === "none" || ids.has(p.id)) {
        err(
          "FLOW_DUPLICATE_PATH",
          p.id === "none"
            ? 'Path id "none" is reserved'
            : `Duplicate path id "${p.id}"`,
          `${pp}/id`,
          n.id,
        );
      }
      ids.add(p.id);
    });
  });

  // variables
  const written = new Set<string>(Object.keys(flow.variables ?? {}));
  for (const n of nodes) {
    if (n.type === "set") for (const k of Object.keys(n.assign)) written.add(k);
    if (n.type === "http") {
      for (const k of Object.keys(n.map ?? {})) written.add(k);
      written.add(`${n.id}.status`);
    }
    if (n.type === "mcp") {
      for (const k of Object.keys(n.map ?? {})) written.add(k);
      written.add(`${n.id}.result`);
    }
    if (n.type === "llm" && n.saveAs) written.add(n.saveAs);
  }
  const known = (name: string): boolean => {
    if (BUILTINS.has(name) || written.has(name)) return true;
    const dot = name.indexOf(".");
    if (dot > 0) {
      const head = name.slice(0, dot);
      const tail = name.slice(dot + 1);
      if (head === "route")
        return nodes.some((n) => n.type === "route" && n.id === tail);
      if (head === "error") return byId.has(tail);
    }
    const parts = name.split(".");
    for (let k = parts.length - 1; k >= 1; k--) {
      if (written.has(parts.slice(0, k).join("."))) return true;
    }
    return false;
  };
  nodes.forEach((n, i) => {
    templatesOf(n, i, (path, s) => {
      for (const v of templateVars(parseTemplate(s))) {
        if (!known(v)) {
          err(
            "FLOW_UNKNOWN_VARIABLE",
            `Variable "${v}" is not defined`,
            path,
            n.id,
          );
        }
      }
    });
  });

  // URLs
  nodes.forEach((n, i) => {
    if (n.type !== "http") return;
    const p = urlProblem(n.url);
    if (p) err(p.code, p.message, `/nodes/${i}/url`, n.id);
  });
  (flow.tools?.toolSources ?? []).forEach((s, i) => {
    if (s.kind !== "mcp") return;
    const p = urlProblem(s.url);
    if (p) err(p.code, p.message, `/tools/toolSources/${i}/url`);
  });

  // secrets
  const declared = new Map<string, string>();
  const refs: { name: string; path: string }[] = [];
  (flow.secrets ?? []).forEach((s, i) => {
    declared.set(s, declared.get(s) ?? `/secrets/${i}`);
    refs.push({ name: s, path: `/secrets/${i}` });
  });
  for (const [k, m] of Object.entries(flow.models)) {
    if ("apiKeySecret" in m) {
      const path = `/models/${esc(k)}/apiKeySecret`;
      declared.set(m.apiKeySecret, declared.get(m.apiKeySecret) ?? path);
      refs.push({ name: m.apiKeySecret, path });
    }
  }
  (flow.tools?.toolSources ?? []).forEach((s, i) => {
    if (s.kind === "mcp" && s.auth?.type === "bearer") {
      const path = `/tools/toolSources/${i}/auth/secret`;
      declared.set(s.auth.secret, declared.get(s.auth.secret) ?? path);
      refs.push({ name: s.auth.secret, path });
    }
  });
  nodes.forEach((n, i) => {
    if (n.type !== "http") return;
    for (const [h, v] of Object.entries(n.headers ?? {})) {
      if (typeof v === "string") continue;
      const path = `/nodes/${i}/headers/${esc(h)}/secret`;
      if (!declared.has(v.secret)) {
        err(
          "FLOW_SECRET_UNDECLARED",
          `Secret "${v.secret}" is not listed in secrets`,
          path,
          n.id,
        );
      }
      refs.push({ name: v.secret, path });
    }
  });
  for (const r of refs) {
    if (!r.name.startsWith("AGENT_")) {
      err(
        "FLOW_SECRET_PREFIX",
        `Secret "${r.name}" must start with AGENT_`,
        r.path,
      );
    }
  }
  if (ctx?.projectSecrets) {
    const have = new Set(ctx.projectSecrets);
    for (const [name, path] of declared) {
      if (!have.has(name)) {
        err(
          "FLOW_SECRET_MISSING",
          `Secret "${name}" does not exist in this project`,
          path,
        );
      }
    }
  }

  // models
  for (const [k, m] of Object.entries(flow.models)) {
    if ("use" in m) {
      const target = flow.models[m.use];
      if (!target || "use" in target) {
        err(
          "FLOW_MODEL_UNKNOWN",
          `Model "${m.use}" is not defined or is itself an alias`,
          `/models/${esc(k)}/use`,
        );
      }
    }
  }
  nodes.forEach((n, i) => {
    if (n.type !== "route" && n.type !== "llm") return;
    const name = n.model ?? (n.type === "route" ? "classifier" : "default");
    if (!(name in flow.models)) {
      err(
        "FLOW_MODEL_UNKNOWN",
        `Model "${name}" is not defined in models`,
        `/nodes/${i}/model`,
        n.id,
      );
    }
  });

  // MCP sources and tools
  const mcpNames = new Set<string>();
  for (const s of flow.tools?.toolSources ?? [])
    if (s.kind === "mcp") mcpNames.add(s.name);
  const toolNames = ctx?.toolNames ? new Set(ctx.toolNames) : undefined;
  nodes.forEach((n, i) => {
    if (n.type === "mcp") {
      if (n.source === "service") {
        if (ctx?.hasService === false) {
          err(
            "FLOW_SERVICE_MISSING",
            "This project has no service tool source",
            `/nodes/${i}/source`,
            n.id,
          );
        }
      } else if (!mcpNames.has(n.source)) {
        err(
          "FLOW_MCP_SOURCE_UNKNOWN",
          `MCP source "${n.source}" is not defined in tools.toolSources`,
          `/nodes/${i}/source`,
          n.id,
        );
      }
      if (toolNames && !toolNames.has(n.tool)) {
        issue(
          warnings,
          "FLOW_TOOL_UNKNOWN",
          `Tool "${n.tool}" was not found`,
          `/nodes/${i}/tool`,
          n.id,
        );
      }
    }
    if (n.type === "llm" && toolNames && Array.isArray(n.tools)) {
      n.tools.forEach((t, j) => {
        if (!toolNames.has(t)) {
          issue(
            warnings,
            "FLOW_TOOL_UNKNOWN",
            `Tool "${t}" was not found`,
            `/nodes/${i}/tools/${j}`,
            n.id,
          );
        }
      });
    }
  });

  return finish();
}
