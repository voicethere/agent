import { agentLog, disconnectClient, sendToClient, speak } from "../runtime.js";
import type { ToolRegistry } from "../llm/mcp/tool-registry.js";
import type { LlmProvider } from "../llm/types.js";
import { createClassifier } from "./classify.js";
import type {
  FlowEffects,
  FlowHttpRequest,
  FlowHttpResponse,
} from "./core/effects.js";
import type { FlowTraceEvent } from "./core/trace.js";
import type { FlowModel } from "./core/types.js";
import { runLlmNode } from "./llm-node.js";

export const HTTP_MAX_RESPONSE_BYTES = 64 * 1024;

export type FlowLog = (
  level: "info" | "warn",
  message: string,
  fields: Record<string, unknown>,
  sessionId?: string,
) => void;

export interface NodeEffectsOptions {
  sessionId: string;
  env: Record<string, string | undefined>;
  /** Resolves (and caches) the provider for a model entry. */
  providerFor: (model: FlowModel) => LlmProvider;
  registry?: ToolRegistry | undefined;
  /** Awaited before the first tool use (project service readiness). */
  beforeTools?: () => Promise<void>;
  /** Default: `agentLog`. Every log line of the effects goes through it. */
  log?: FlowLog;
  fetchImpl?: typeof fetch;
}

function coded(code: string, message: string): Error {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

async function readCapped(res: Response, max: number): Promise<string> {
  const body = res.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      void reader.cancel().catch(() => {});
      throw coded("HTTP_RESPONSE_TOO_LARGE", "response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function exposedNames(source: string, tool: string): string[] {
  const clean = (n: string): string => {
    const out = n.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
    return out.length > 0 ? out : "_";
  };
  return [clean(tool), clean(`${source}__${tool}`)];
}

/** Effects of a flow session wired to the agent runtime. */
export function createNodeEffects(o: NodeEffectsOptions): FlowEffects {
  const log: FlowLog =
    o.log ??
    ((level, message, fields, sessionId) =>
      agentLog(level, message, fields, sessionId));
  const doFetch = o.fetchImpl ?? fetch;
  const sid = o.sessionId;

  return {
    speak(text, so) {
      const h = speak(sid, text, {
        interruptible: so.interruptible,
        turnId: so.turnId,
        ...(so.filler ? { kind: "filler" as const } : {}),
      });
      return {
        done: h.done.then((r) => ({ status: r.status })),
        cancel: () => h.cancel(),
      };
    },
    chat(text, co) {
      sendToClient(sid, { type: "chat_reply", text });
      // The runner writes the agent transcript row from the speak request, as for
      // an LLM agent's chat reply (`speakChatReplies`, default true).
      speak(sid, text, co?.turnId ? { turnId: co.turnId } : undefined);
    },
    async http(req: FlowHttpRequest, signal): Promise<FlowHttpResponse> {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k] = v;
        else {
          const secret = o.env[v.secret];
          if (secret === undefined || secret === "")
            throw coded("FLOW_SECRET_MISSING", "secret is not set");
          headers[k] = `${v.prefix}${secret}`;
        }
      }
      let body: string | undefined;
      if (req.body !== undefined && req.method !== "GET") {
        body = JSON.stringify(req.body);
        if (
          !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")
        )
          headers["Content-Type"] = "application/json";
      }
      let res: Response;
      try {
        res = await doFetch(req.url, {
          method: req.method,
          headers,
          ...(body !== undefined ? { body } : {}),
          redirect: "manual",
          signal,
        });
      } catch {
        throw coded(
          signal.aborted ? "HTTP_TIMEOUT" : "HTTP_NETWORK",
          "request failed",
        );
      }
      if (res.status >= 300 && res.status < 400) {
        void res.body?.cancel().catch(() => {});
        throw coded("HTTP_REDIRECT_BLOCKED", "redirect blocked");
      }
      let text: string;
      try {
        text = await readCapped(res, HTTP_MAX_RESPONSE_BYTES);
      } catch (err) {
        if ((err as { code?: string }).code) throw err;
        throw coded(
          signal.aborted ? "HTTP_TIMEOUT" : "HTTP_NETWORK",
          "response read failed",
        );
      }
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // not JSON: keep the text
      }
      return { status: res.status, body: parsed };
    },
    async tool(source, tool, args, signal, to) {
      await o.beforeTools?.();
      const reg = o.registry;
      if (!reg) return { content: "no tools available", isError: true };
      const names = new Set(exposedNames(source, tool));
      const entry = reg
        .list()
        .find((e) => e.owner === source && names.has(e.spec.name));
      if (!entry)
        return { content: `tool ${tool} is not available`, isError: true };
      return reg.call(entry.spec.name, args, {
        signal,
        timeoutMs: to?.timeoutMs ?? 15_000,
        sessionId: sid,
      });
    },
    llm(req, signal) {
      const provider = o.providerFor(req.model);
      const run = async function* () {
        if (req.tools !== "none") await o.beforeTools?.();
        yield* runLlmNode(provider, o.registry, req, signal, {
          sessionId: sid,
          log: (level, message, fields) => log(level, message, fields, sid),
        });
      };
      return run();
    },
    classify(req, signal) {
      return createClassifier(o.providerFor(req.model))(req, signal);
    },
    end(reason) {
      log("info", "flow_end", { reason }, sid);
      disconnectClient(sid, { reason });
    },
    log(level, message, fields) {
      log(level, message, fields, sid);
    },
    trace(e: FlowTraceEvent) {
      // Metadata only: ids, types, edges, durations, error codes, variable
      // names and token counts. Never `e.vars`, values or transcripts.
      log(
        "info",
        "flow_step",
        {
          nodeId: e.nodeId,
          type: e.type,
          phase: e.phase,
          seq: e.seq,
          ...(e.edge !== undefined ? { edge: e.edge } : {}),
          ...(e.via !== undefined ? { via: e.via } : {}),
          ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
          ...(e.varsChanged ? { varsChanged: e.varsChanged } : {}),
          ...(e.error !== undefined ? { error: e.error } : {}),
          ...(e.parent !== undefined ? { parent: e.parent } : {}),
          ...(e.tool !== undefined ? { tool: e.tool } : {}),
          ...(e.tokens ? { tokens: e.tokens } : {}),
        },
        sid,
      );
      if (e.type === "route" && e.phase === "exit") {
        log(
          "info",
          "flow_route",
          {
            nodeId: e.nodeId,
            ...(e.edge !== undefined && e.error === undefined
              ? { path: e.edge }
              : {}),
            ...(e.via !== undefined ? { via: e.via } : {}),
            ...(e.durationMs !== undefined ? { latencyMs: e.durationMs } : {}),
            ...(e.error !== undefined ? { error: e.error } : {}),
            ...(e.tokens ? { tokens: e.tokens } : {}),
          },
          sid,
        );
      }
    },
    clock: {
      now: () => Date.now(),
      setTimeout(fn, ms) {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      },
    },
  };
}
