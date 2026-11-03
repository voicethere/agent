import { withStreamBounds } from "../llm/bounded-provider.js";
import { SentenceSplitter } from "../llm/agent/sentence-splitter.js";
import {
  ThinkingStripper,
  stripThinking,
} from "../llm/agent/thinking-stripper.js";
import { MAX_RESULT_BYTES } from "../llm/mcp/tool-registry.js";
import type { ToolRegistry } from "../llm/mcp/tool-registry.js";
import { LlmProviderError } from "../llm/types.js";
import type {
  LlmMessage,
  LlmProvider,
  LlmStreamEvent,
  LlmToolResult,
  LlmToolSpec,
} from "../llm/types.js";
import type { FlowLlmCall, FlowLlmEvent } from "./core/effects.js";

export const LLM_FIRST_TOKEN_TIMEOUT_MS = 10_000;
export const LLM_TOTAL_TIMEOUT_MS = 60_000;
export const LLM_TOOL_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_TOKENS = 1024;

export interface RunLlmNodeOptions {
  sessionId: string;
  turnId?: string;
  /** Test override of the first-token bound. */
  firstTokenTimeoutMs?: number;
  /** Test override of the per-round bound. */
  totalTimeoutMs?: number;
  /** Test override of the per-tool bound. */
  toolTimeoutMs?: number;
  log?: (
    level: "info" | "warn",
    message: string,
    fields: Record<string, unknown>,
  ) => void;
}

function truncate(text: string, max: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= max) return text;
  let end = max;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return `${buf.subarray(0, end).toString("utf8")}\n[truncated]`;
}

class EventQueue<T> {
  private items: T[] = [];
  private waiter: (() => void) | undefined;
  private finished = false;
  private failure: { err: unknown } | undefined;

  push(item: T): void {
    if (this.finished) return;
    this.items.push(item);
    this.wake();
  }
  end(): void {
    this.finished = true;
    this.wake();
  }
  fail(err: unknown): void {
    this.failure = { err };
    this.finished = true;
    this.wake();
  }
  private wake(): void {
    const w = this.waiter;
    this.waiter = undefined;
    w?.();
  }
  async *drain(): AsyncGenerator<T> {
    for (;;) {
      if (this.items.length > 0) {
        yield this.items.shift()!;
        continue;
      }
      if (this.finished) {
        if (this.failure) throw this.failure.err;
        return;
      }
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}

function offeredTools(
  registry: ToolRegistry | undefined,
  tools: FlowLlmCall["tools"],
  log: RunLlmNodeOptions["log"],
): LlmToolSpec[] {
  if (!registry || tools === "none") return [];
  const all = registry.list().map((e) => e.spec);
  if (tools === "all") return all;
  const byName = new Map(all.map((t) => [t.name, t]));
  const out: LlmToolSpec[] = [];
  let skipped = 0;
  for (const name of tools) {
    const t = byName.get(name);
    if (t) out.push(t);
    else skipped += 1;
  }
  if (skipped > 0) log?.("warn", "flow llm tools skipped", { skipped });
  return out;
}

/**
 * One llm node: up to `maxRounds` provider rounds, with tool calls between
 * them. Yields sentences (when `call.speak`), tool start/end events and a
 * final `done`.
 */
export async function* runLlmNode(
  provider: LlmProvider,
  registry: ToolRegistry | undefined,
  call: FlowLlmCall,
  signal: AbortSignal,
  opts: RunLlmNodeOptions,
): AsyncGenerator<FlowLlmEvent> {
  const bounded = withStreamBounds(provider, {
    firstTokenTimeoutMs: opts.firstTokenTimeoutMs ?? LLM_FIRST_TOKEN_TIMEOUT_MS,
    totalTimeoutMs:
      call.timeoutMs ?? opts.totalTimeoutMs ?? LLM_TOTAL_TIMEOUT_MS,
    retries: 0,
  });
  const toolTimeoutMs = opts.toolTimeoutMs ?? LLM_TOOL_TIMEOUT_MS;
  const specs = offeredTools(registry, call.tools, opts.log);
  const offered = new Set(specs.map((t) => t.name));
  const maxRounds = Math.max(1, call.maxRounds ?? 5);
  const q = new EventQueue<FlowLlmEvent>();

  let sentenceSeen = false;
  let fillerTimer: ReturnType<typeof setTimeout> | undefined;
  if (call.speak && call.filler) {
    const f = call.filler;
    fillerTimer = setTimeout(
      () => {
        fillerTimer = undefined;
        if (!sentenceSeen)
          q.push({ type: "sentence", text: f.text, filler: true });
      },
      Math.max(0, f.afterMs),
    );
  }
  const sentence = (text: string): void => {
    if (!call.speak || text.trim() === "") return;
    sentenceSeen = true;
    if (fillerTimer) {
      clearTimeout(fillerTimer);
      fillerTimer = undefined;
    }
    q.push({ type: "sentence", text });
  };

  const messages: LlmMessage[] = call.messages.map((m) => ({
    role: m.role,
    text: m.text,
  }));
  if (messages.length === 0 || messages[0]!.role === "assistant") {
    // Providers want a conversation that starts with the caller.
    messages.unshift({ role: "user", text: "(The call has started.)" });
  }

  const pump = (async () => {
    const texts: string[] = [];
    let input: number | undefined;
    let output: number | undefined;
    for (let round = 1; round <= maxRounds; round += 1) {
      const splitter = new SentenceSplitter();
      const stripper = new ThinkingStripper();
      let final: LlmStreamEvent | undefined;
      for await (const ev of bounded.stream({
        model: call.model.model,
        system: call.system,
        messages,
        tools: specs,
        temperature: 0.2,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        signal,
      })) {
        if (signal.aborted) break;
        if (ev.type === "text_delta") {
          for (const s of splitter.push(stripper.push(ev.text))) sentence(s);
        } else {
          final = ev;
        }
      }
      if (signal.aborted) throw new LlmProviderError("LLM_ABORTED", "aborted");
      if (!final || final.type !== "done") {
        throw new LlmProviderError(
          "LLM_PROVIDER_ERROR",
          "stream ended without done",
        );
      }
      const tail = stripper.end();
      for (const s of tail
        ? [...splitter.push(tail), ...splitter.end()]
        : splitter.end())
        sentence(s);
      const cleaned = stripThinking(final.text);
      if (cleaned.text) texts.push(cleaned.text);
      if (final.usage?.inputTokens !== undefined)
        input = (input ?? 0) + final.usage.inputTokens;
      if (final.usage?.outputTokens !== undefined)
        output = (output ?? 0) + final.usage.outputTokens;

      if (final.toolCalls.length === 0 || round === maxRounds) break;

      messages.push({
        role: "assistant",
        text: final.text,
        toolCalls: final.toolCalls,
        ...(cleaned.strippedChars > 0 || final.providerState === undefined
          ? {}
          : { providerState: final.providerState }),
      });
      const results: LlmToolResult[] = await Promise.all(
        final.toolCalls.map(async (c): Promise<LlmToolResult> => {
          q.push({ type: "tool", name: c.name, phase: "start" });
          const t0 = Date.now();
          let content: string;
          let isError = false;
          if (!registry || !offered.has(c.name)) {
            content = `tool ${c.name} is not available`;
            isError = true;
          } else {
            const ctl = new AbortController();
            const onAbort = () => ctl.abort();
            signal.addEventListener("abort", onAbort, { once: true });
            const timer = setTimeout(() => ctl.abort(), toolTimeoutMs);
            try {
              const r = await registry.call(c.name, c.input, {
                signal: ctl.signal,
                timeoutMs: toolTimeoutMs,
                sessionId: opts.sessionId,
                ...(opts.turnId ? { turnId: opts.turnId } : {}),
                callId: c.id,
              });
              content = r.content;
              isError = r.isError;
            } catch {
              content = "tool call failed";
              isError = true;
            } finally {
              clearTimeout(timer);
              signal.removeEventListener("abort", onAbort);
            }
          }
          q.push({
            type: "tool",
            name: c.name,
            phase: "end",
            durationMs: Date.now() - t0,
            ...(isError ? { error: "TOOL_ERROR" } : {}),
          });
          return {
            callId: c.id,
            name: c.name,
            content: truncate(content, MAX_RESULT_BYTES),
            isError,
          };
        }),
      );
      messages.push({ role: "tool", results });
    }
    q.push({
      type: "done",
      text: texts.join(" "),
      ...(input !== undefined || output !== undefined
        ? {
            tokens: {
              ...(input !== undefined ? { input } : {}),
              ...(output !== undefined ? { output } : {}),
            },
          }
        : {}),
    });
  })();
  pump.then(
    () => q.end(),
    (err) => q.fail(err),
  );
  try {
    yield* q.drain();
  } finally {
    if (fillerTimer) clearTimeout(fillerTimer);
  }
}
