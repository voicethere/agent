import { createRedactor, secretValuesFromEnv } from "../llm/agent/redact.js";
import type { FlowEffects } from "./core/effects.js";
import type { FlowMockCase, FlowMocks } from "./core/mocks.js";

export interface RecordingSink {
  add(nodeId: string, c: FlowMockCase): void;
}

/** Collects recorded cases into a `FlowMocks` document. */
export function createMockRecorder(): {
  sink: RecordingSink;
  mocks(): FlowMocks;
} {
  const nodes: Record<string, FlowMockCase[]> = Object.create(null);
  return {
    sink: {
      add(nodeId, c) {
        (nodes[nodeId] ??= []).push(c);
      },
    },
    mocks: () => ({ version: 1, nodes: { ...nodes } }),
  };
}

export interface RecordingOptions {
  env: Record<string, string | undefined>;
  /** Secret names the flow declares, redacted even when not `AGENT_*`. */
  referencedSecrets?: string[];
}

const DROPPED_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
]);

function codeOf(err: unknown): string | undefined {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : undefined;
}

/**
 * Passes every call through and appends its result as case `recorded-<n>`.
 * Values are redacted (secret values from the env, sensitive keys, personal
 * data) before they reach the sink; auth and cookie headers are dropped.
 */
export function wrapRecording(
  effects: FlowEffects,
  sink: RecordingSink,
  opts: RecordingOptions,
): FlowEffects {
  const redactor = createRedactor({
    secretValues: secretValuesFromEnv(opts.env, opts.referencedSecrets ?? []),
    mode: "redacted",
  });
  const counts = new Map<string, number>();
  let current = "";
  const record = (nodeId: string, c: Omit<FlowMockCase, "name">): void => {
    const n = (counts.get(nodeId) ?? 0) + 1;
    counts.set(nodeId, n);
    sink.add(nodeId, { name: `recorded-${n}`, ...c });
  };

  return {
    ...effects,
    trace(e) {
      if (e.phase === "enter" && e.parent === undefined) current = e.nodeId;
      effects.trace(e);
    },
    async http(req, signal) {
      const nodeId = current;
      try {
        const res = await effects.http(req, signal);
        if (signal.aborted) {
          // The interpreter gave up (timeout): replay must take that path.
          record(nodeId, { http: { error: "HTTP_TIMEOUT" } });
          return res;
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers ?? {}))
          if (!DROPPED_HEADERS.has(k.toLowerCase()))
            headers[k] = String(redactor.redact(v));
        record(nodeId, {
          http: {
            status: res.status,
            ...(Object.keys(headers).length > 0 ? { headers } : {}),
            body: redactor.redact(res.body),
          },
        });
        return res;
      } catch (err) {
        const code = codeOf(err);
        if (code === "HTTP_TIMEOUT" || code === "HTTP_NETWORK")
          record(nodeId, { http: { error: code } });
        throw err;
      }
    },
    async tool(source, tool, args, signal, o) {
      const nodeId = current;
      const res = await effects.tool(source, tool, args, signal, o);
      if (signal.aborted) {
        record(nodeId, { mcp: { error: "MCP_TIMEOUT" } });
        return res;
      }
      if (res.isError)
        record(nodeId, {
          mcp: { isError: true, content: String(redactor.redact(res.content)) },
        });
      else {
        let value: unknown = res.content;
        try {
          value = JSON.parse(res.content);
        } catch {
          // plain text result
        }
        record(nodeId, { mcp: { result: redactor.redact(value) } });
      }
      return res;
    },
    llm(req, signal) {
      const nodeId = current;
      const inner = effects.llm(req, signal);
      return (async function* () {
        for await (const ev of inner) {
          if (ev.type === "done" && signal.aborted)
            record(nodeId, { llm: { error: "LLM_TIMEOUT" } });
          else if (ev.type === "done")
            record(nodeId, {
              llm: { text: String(redactor.redact(ev.text)) },
            });
          yield ev;
        }
      })();
    },
    async classify(req, signal) {
      const nodeId = current;
      const res = await effects.classify(req, signal);
      if (signal.aborted) record(nodeId, { route: { error: "ROUTE_TIMEOUT" } });
      else record(nodeId, { route: { path: res.path } });
      return res;
    },
  };
}
