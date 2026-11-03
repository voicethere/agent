import type { FlowEffects, FlowLlmEvent } from "./effects.js";
import type { FlowMockCase, FlowMocks } from "./mocks.js";
import type { FlowTraceEvent } from "./trace.js";

export type MockBaseEffects = Pick<
  FlowEffects,
  "speak" | "chat" | "end" | "trace" | "clock"
> &
  Partial<Pick<FlowEffects, "log">>;

export interface MockEffectsOptions {
  /** Which case answers a node. Default: the first one. */
  pick?: (nodeId: string, cases: FlowMockCase[]) => FlowMockCase | undefined;
}

function coded(code: string): Error {
  const err = new Error(code) as Error & { code: string };
  err.code = code;
  return err;
}

/**
 * Effects that answer `http`, `tool`, `llm` and `classify` from mock cases.
 * The interpreter does not pass node ids to effects, so the current node is
 * tracked from its `enter` trace events (child tool events carry `parent`).
 */
export function createMockEffects(
  base: MockBaseEffects,
  mocks: FlowMocks,
  opts: MockEffectsOptions = {},
): FlowEffects {
  let current = "";
  const pick = opts.pick ?? ((_id, cases) => cases[0]);

  function caseFor(nodeId: string = current): FlowMockCase {
    const cases = Object.hasOwn(mocks.nodes, nodeId)
      ? mocks.nodes[nodeId]
      : undefined;
    const c = cases && cases.length > 0 ? pick(nodeId, cases) : undefined;
    if (!c) throw coded("MOCK_MISSING");
    return c;
  }

  return {
    speak: (text, o) => base.speak(text, o),
    ...(base.chat ? { chat: (t: string) => base.chat!(t) } : {}),
    end: (reason) => base.end(reason),
    ...(base.log ? { log: base.log.bind(base) } : {}),
    clock: base.clock,
    trace(e: FlowTraceEvent) {
      if (e.phase === "enter" && e.parent === undefined) current = e.nodeId;
      base.trace(
        e.type === "route" && e.phase === "exit" && e.via === "classifier"
          ? { ...e, via: "mock" }
          : e,
      );
    },
    async http() {
      const h = caseFor().http;
      if (!h) throw coded("MOCK_MISSING");
      if ("error" in h) throw coded(h.error);
      return {
        status: h.status,
        ...(h.headers ? { headers: h.headers } : {}),
        body: h.body,
      };
    },
    async tool() {
      const m = caseFor().mcp;
      if (!m) throw coded("MOCK_MISSING");
      if ("isError" in m) return { content: m.content, isError: true };
      return {
        content:
          typeof m.result === "string" ? m.result : JSON.stringify(m.result),
      };
    },
    llm(req) {
      const c = caseFor();
      const fn = (async function* (): AsyncGenerator<FlowLlmEvent> {
        const l = c.llm;
        if (!l) throw coded("MOCK_MISSING");
        // v1: toolCalls are trace-only (child start/end events); no tool mocks
        // run, and the mocked text is the answer.
        for (const t of l.toolCalls ?? []) {
          yield { type: "tool", name: t.name, phase: "start" };
          yield { type: "tool", name: t.name, phase: "end", durationMs: 0 };
        }
        if (req.speak) yield { type: "sentence", text: l.text };
        yield { type: "done", text: l.text };
      })();
      return fn;
    },
    async classify() {
      const r = caseFor().route;
      if (!r) throw coded("MOCK_MISSING");
      return { path: r.path };
    },
  };
}
