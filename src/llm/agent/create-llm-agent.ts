import { randomUUID } from "node:crypto";

import {
  agentLog,
  announce,
  cancelSpeech,
  parseChatText,
  sendToClient,
  setAgentState,
  setBargeIn,
  speak,
} from "../../runtime.js";
import type {
  AgentHandlers,
  AgentInterruptedContext,
  SessionContext,
} from "../../runtime.js";
import { resolveModel } from "../catalog.js";
import { createLlmProvider } from "../index.js";
import { McpToolSource } from "../mcp/mcp-tool-source.js";
import type { McpToolSourceOptions } from "../mcp/mcp-tool-source.js";
import { ToolRegistry } from "../mcp/tool-registry.js";
import type { CustomTool } from "../mcp/tool-registry.js";
import { LlmProviderError } from "../types.js";
import type {
  LlmMessage,
  LlmProvider,
  LlmStreamEvent,
  LlmToolResult,
} from "../types.js";
import { LLM_AGENT_CONFIG_DEFAULTS, validateLlmAgentConfig } from "./config.js";
import type { LlmAgentConfig } from "./config.js";
import { ConversationHistory } from "./history.js";
import type { LlmAgentHooks, TurnContext, TurnSummary } from "./hooks.js";
import { SentenceSplitter } from "./sentence-splitter.js";

const D = LLM_AGENT_CONFIG_DEFAULTS;
const CANCEL_SETTLE_MS = 2_000;

export interface CreateLlmAgentOptions {
  /** Validated here; an invalid config throws `LLM_CONFIG_INVALID`. */
  config: unknown;
  systemPrompt: string;
  tools?: CustomTool[];
  hooks?: LlmAgentHooks;
  /** Environment used to resolve secrets. Default `process.env`. */
  env?: () => Record<string, string | undefined>;
  /** Test injection. */
  provider?: LlmProvider;
  now?: () => number;
  /** Test injection for MCP tool sources. */
  sourceFactory?: (opts: McpToolSourceOptions) => McpToolSource;
}

type Source = "voice" | "chat";

interface TurnState {
  turnId: string;
  source: Source;
  inputText: string;
  controller: AbortController;
  startedAt: number;
  spoken: string[];
  toolCalls: TurnSummary["toolCalls"];
  llmCalls: number;
  firstTokenMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  errorCode?: string;
  abortStatus?: "interrupted" | "cancelled";
  roundOpen: boolean;
  roundText: string;
  playedOverride?: string;
  spokeFirst: boolean;
  fillerSpoken: boolean;
  fallbackSpoken: boolean;
  status: TurnSummary["status"];
}

interface ActiveTurn {
  turnId: string;
  state: TurnState;
  promise: Promise<void>;
}

interface SessionState {
  sessionId: string;
  history: ConversationHistory;
  active?: ActiveTurn;
  queued?: { text: string; source: Source };
  announcing: number;
  chain: Promise<void>;
  lastInterruption?: {
    turnId: string;
    playedText: string;
    unplayedText: string;
  };
  ended: boolean;
}

function configError(message: string, code: string): Error {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

function truncateBytes(text: string, max: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= max) return text;
  let end = max;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return `${buf.subarray(0, end).toString("utf8")}\n[truncated]`;
}

function interruptionNote(played: string, unplayed: string): string {
  return `(The caller interrupted your previous reply after: "${played}". They did not hear: "${unplayed}".)`;
}

function nonEmpty(v: string | undefined): v is string {
  return v !== undefined && v.length > 0;
}

export function createLlmAgent(opts: CreateLlmAgentOptions): AgentHandlers {
  const validated = validateLlmAgentConfig(opts.config);
  if (!validated.ok) {
    throw configError(
      `invalid LLM agent config:\n${validated.errors
        .map((e) => `${e.path || "(root)"}: ${e.message}`)
        .join("\n")}`,
      "LLM_CONFIG_INVALID",
    );
  }
  const config: LlmAgentConfig = validated.config;
  const hooks = opts.hooks ?? {};
  const now = opts.now ?? Date.now;
  const getEnv = opts.env ?? (() => process.env);
  const makeSource =
    opts.sourceFactory ?? ((o: McpToolSourceOptions) => new McpToolSource(o));

  const maxRounds = config.tools?.maxRounds ?? D.toolMaxRounds;
  const toolTimeoutMs = config.tools?.timeoutMs ?? D.toolTimeoutMs;
  const toolMaxBytes = config.tools?.maxResultBytes ?? D.toolMaxResultBytes;
  const policy = config.interruptPolicy ?? D.interruptPolicy;
  const fallbackText = config.fallbackText ?? D.fallbackText;
  const speakChat = config.speakChatReplies ?? D.speakChatReplies;
  const useNote = config.history?.interruptionNote ?? D.interruptionNote;
  const historyTurns = config.history?.turns ?? D.historyTurns;
  const serviceWaitMs = config.serviceWaitMs ?? D.serviceWaitMs;

  let provider: LlmProvider | undefined = opts.provider;
  let registry: ToolRegistry | undefined;
  let serviceSource: McpToolSource | undefined;
  let serviceWaited = false;
  const sessions = new Map<string, SessionState>();

  // ---- hooks -------------------------------------------------------------

  async function callHook<T>(
    name: string,
    sessionId: string,
    fn: () => T | Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      agentLog("error", `llm hook ${name} failed: ${message}`, sessionId);
      return { ok: false };
    }
  }

  // ---- delivery ----------------------------------------------------------

  function trackAnnouncement(s: SessionState, done: Promise<unknown>): void {
    s.announcing += 1;
    void done.then(
      () => {
        s.announcing = Math.max(0, s.announcing - 1);
      },
      () => {
        s.announcing = Math.max(0, s.announcing - 1);
      },
    );
  }

  /** The one place where a sentence of a reply leaves the agent. */
  function deliver(
    s: SessionState,
    t: TurnState,
    text: string,
    interruptible = true,
  ): void {
    t.spoken.push(text);
    if (!t.spokeFirst) {
      t.spokeFirst = true;
      setAgentState(s.sessionId, "speaking");
    }
    if (t.source === "chat") {
      sendToClient(s.sessionId, {
        type: "assistant_delta",
        turnId: t.turnId,
        text,
      });
    }
    if (t.source === "voice" || speakChat) {
      if (interruptible) {
        speak(s.sessionId, text, { turnId: t.turnId });
      } else {
        const h = announce(s.sessionId, text, { turnId: t.turnId });
        trackAnnouncement(s, h.done);
      }
    }
  }

  function speakAnnouncement(
    s: SessionState,
    turnId: string,
    text: string,
    interruptible: boolean,
  ): void {
    if (interruptible) {
      speak(s.sessionId, text, { turnId });
    } else {
      trackAnnouncement(s, announce(s.sessionId, text, { turnId }).done);
    }
  }

  // ---- tools -------------------------------------------------------------

  function buildRegistry(env: Record<string, string | undefined>): void {
    const reg = new ToolRegistry({
      log: (level, message, fields) => agentLog(level, message, fields ?? {}),
    });
    for (const tool of opts.tools ?? []) reg.addCustomTool(tool);
    const sources: McpToolSource[] = [];
    for (const src of config.toolSources ?? []) {
      if (src.kind === "service") {
        const base = env.VOICETHERE_SERVICE_URL;
        if (!nonEmpty(base)) {
          agentLog(
            "warn",
            "toolSources: service configured but this project has no service",
          );
          continue;
        }
        const headers: Record<string, string> = {};
        const token = env.VOICETHERE_SERVICE_TOKEN;
        if (nonEmpty(token)) {
          headers.Authorization = `Bearer ${token}`;
        } else {
          agentLog("warn", "toolSources: VOICETHERE_SERVICE_TOKEN is not set");
        }
        const source = makeSource({
          name: "service",
          url: `${base}${src.path ?? D.servicePath}`,
          headers,
          allow: src.allow,
          deny: src.deny,
          log: (level, message, fields) =>
            agentLog(level, message, fields ?? {}),
        });
        serviceSource = source;
        sources.push(source);
      } else {
        const headers: Record<string, string> = {};
        let missing: string | undefined;
        const auth = src.auth ?? { type: "none" as const };
        if (auth.type === "bearer") {
          const v = env[auth.secret];
          if (nonEmpty(v)) headers.Authorization = `Bearer ${v}`;
          else missing = auth.secret;
        } else if (auth.type === "headers") {
          for (const [header, envName] of Object.entries(auth.headers)) {
            const v = env[envName];
            if (nonEmpty(v)) headers[header] = v;
            else missing = envName;
          }
        }
        if (missing) {
          agentLog(
            "warn",
            `toolSources: ${src.name} skipped, environment variable ${missing} is not set`,
          );
          continue;
        }
        sources.push(
          makeSource({
            name: src.name,
            url: src.url,
            headers,
            allow: src.allow,
            deny: src.deny,
            log: (level, message, fields) =>
              agentLog(level, message, fields ?? {}),
          }),
        );
      }
    }
    for (const source of sources) {
      reg.addSource(source);
      source.start();
    }
    registry = reg;
  }

  async function runTools(
    s: SessionState,
    t: TurnState,
    ctx: TurnContext,
    calls: { id: string; name: string; input: unknown }[],
  ): Promise<LlmToolResult[]> {
    const signal = t.controller.signal;
    const aborted = new Promise<"aborted">((resolve) => {
      if (signal.aborted) resolve("aborted");
      else
        signal.addEventListener("abort", () => resolve("aborted"), {
          once: true,
        });
    });
    const one = async (call: {
      id: string;
      name: string;
      input: unknown;
    }): Promise<LlmToolResult> => {
      const started = now();
      let content = "";
      let isError = false;
      const work = (async () => {
        const hooked = hooks.onToolCall
          ? await callHook("onToolCall", s.sessionId, () =>
              hooks.onToolCall!({ name: call.name, args: call.input }, ctx),
            )
          : undefined;
        if (hooked?.ok && hooked.value) {
          return {
            content: String(hooked.value.result),
            isError: hooked.value.isError === true,
          };
        }
        if (!registry) return { content: "no tools available", isError: true };
        return registry.call(call.name, call.input, {
          signal,
          timeoutMs: toolTimeoutMs,
          sessionId: s.sessionId,
        });
      })();
      const raced = await Promise.race([work, aborted]);
      if (raced === "aborted") {
        work.catch(() => {});
        content = "cancelled";
        isError = true;
      } else {
        content = raced.content;
        isError = raced.isError;
        if (hooks.onToolResult) {
          const r = await callHook("onToolResult", s.sessionId, () =>
            hooks.onToolResult!(
              { name: call.name, args: call.input, result: content, isError },
              ctx,
            ),
          );
          if (r.ok && typeof r.value === "string") content = r.value;
        }
      }
      content = truncateBytes(content, toolMaxBytes);
      t.toolCalls.push({ name: call.name, isError, ms: now() - started });
      return { callId: call.id, name: call.name, content, isError };
    };
    return Promise.all(calls.map(one));
  }

  // ---- one LLM round -----------------------------------------------------

  async function emitSentence(
    s: SessionState,
    t: TurnState,
    ctx: TurnContext,
    sentence: string,
  ): Promise<void> {
    let out: string = sentence;
    if (hooks.onAssistantText) {
      const r = await callHook("onAssistantText", s.sessionId, () =>
        hooks.onAssistantText!(sentence, ctx),
      );
      if (r.ok && r.value !== undefined) {
        if (r.value === null || r.value === "") return;
        if (typeof r.value === "string") out = r.value;
      }
    }
    if (t.controller.signal.aborted) return;
    t.roundText += `${t.roundText ? " " : ""}${out}`;
    deliver(s, t, out);
  }

  async function runRound(
    s: SessionState,
    t: TurnState,
    ctx: TurnContext,
  ): Promise<Extract<LlmStreamEvent, { type: "done" }>> {
    const signal = t.controller.signal;
    let messages: LlmMessage[] = s.history.messages();
    if (hooks.onBeforeLlmCall) {
      const r = await callHook("onBeforeLlmCall", s.sessionId, () =>
        hooks.onBeforeLlmCall!(messages, ctx),
      );
      if (r.ok && Array.isArray(r.value)) messages = r.value;
    }
    if (messages.length > 0 && messages[0].role === "assistant") {
      // Providers want a conversation that starts with the caller.
      messages = [
        { role: "user", text: "(The call has started.)" },
        ...messages,
      ];
    }
    t.llmCalls += 1;
    t.roundOpen = true;
    t.roundText = "";
    const splitter = new SentenceSplitter();
    let done: Extract<LlmStreamEvent, { type: "done" }> | undefined;
    const stream = provider!.stream({
      model: resolveModel(config.provider, config.model),
      system: opts.systemPrompt,
      messages,
      tools: registry ? registry.list().map((e) => e.spec) : [],
      temperature: config.temperature,
      maxOutputTokens: config.maxOutputTokens ?? D.maxOutputTokens,
      signal,
    });
    for await (const ev of stream) {
      if (signal.aborted) break;
      if (ev.type === "text_delta") {
        if (t.firstTokenMs === undefined) t.firstTokenMs = now() - t.startedAt;
        for (const sentence of splitter.push(ev.text)) {
          await emitSentence(s, t, ctx, sentence);
        }
      } else {
        done = ev;
      }
    }
    if (signal.aborted) throw new LlmProviderError("LLM_ABORTED", "aborted");
    if (!done) {
      throw new LlmProviderError(
        "LLM_PROVIDER_ERROR",
        "stream ended without done",
      );
    }
    for (const sentence of splitter.end()) {
      await emitSentence(s, t, ctx, sentence);
    }
    if (done.usage) {
      if (done.usage.inputTokens !== undefined) {
        t.inputTokens = (t.inputTokens ?? 0) + done.usage.inputTokens;
      }
      if (done.usage.outputTokens !== undefined) {
        t.outputTokens = (t.outputTokens ?? 0) + done.usage.outputTokens;
      }
    }
    t.roundOpen = false;
    return done;
  }

  // ---- one turn ----------------------------------------------------------

  function summarize(t: TurnState): TurnSummary {
    return {
      turnId: t.turnId,
      status: t.status,
      assistantText: t.spoken.join(" "),
      toolCalls: [...t.toolCalls],
      llmCalls: t.llmCalls,
      ...(t.firstTokenMs !== undefined ? { firstTokenMs: t.firstTokenMs } : {}),
      ...(t.inputTokens !== undefined ? { inputTokens: t.inputTokens } : {}),
      ...(t.outputTokens !== undefined ? { outputTokens: t.outputTokens } : {}),
      ...(t.errorCode ? { errorCode: t.errorCode } : {}),
    };
  }

  function speakFallback(s: SessionState, t: TurnState): void {
    if (t.fallbackSpoken) return;
    t.fallbackSpoken = true;
    deliver(s, t, fallbackText);
  }

  async function ensureService(t: TurnState): Promise<void> {
    if (serviceWaited || !serviceSource || serviceWaitMs <= 0) return;
    serviceWaited = true;
    if (serviceSource.status === "ready") return;
    const signal = t.controller.signal;
    await Promise.race([
      serviceSource.ready(serviceWaitMs),
      new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    ]);
  }

  async function body(
    s: SessionState,
    t: TurnState,
    ctx: TurnContext,
  ): Promise<TurnSummary> {
    const signal = t.controller.signal;
    let filler: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!provider) {
        throw new LlmProviderError("LLM_BAD_REQUEST", "provider not started");
      }
      await ensureService(t);
      for (let round = 0; round < maxRounds; round += 1) {
        const done = await runRound(s, t, ctx);
        const calls = done.toolCalls;
        if (calls.length === 0) {
          s.history.addAssistant(
            {
              role: "assistant",
              text: done.text,
              ...(done.providerState !== undefined
                ? { providerState: done.providerState }
                : {}),
            },
            { turnId: t.turnId },
          );
          t.status = "completed";
          return summarize(t);
        }
        if (round === maxRounds - 1) {
          // Tools requested again after the last allowed round: keep the text
          // only, so history never holds tool calls without results.
          s.history.addAssistant(
            { role: "assistant", text: done.text },
            { turnId: t.turnId },
          );
          t.errorCode = "LLM_TOOL_ROUNDS_EXCEEDED";
          agentLog(
            "error",
            "llm turn failed: LLM_TOOL_ROUNDS_EXCEEDED",
            s.sessionId,
          );
          speakFallback(s, t);
          t.status = "failed";
          return summarize(t);
        }
        s.history.addAssistant(
          {
            role: "assistant",
            text: done.text,
            toolCalls: calls,
            ...(done.providerState !== undefined
              ? { providerState: done.providerState }
              : {}),
          },
          { turnId: t.turnId },
        );
        setAgentState(s.sessionId, "tool_call", {
          detail: calls
            .map((c) => c.name)
            .join(",")
            .slice(0, 64),
        });
        const fillerCfg = config.tools?.filler;
        if (fillerCfg && !t.fillerSpoken) {
          filler = setTimeout(() => {
            if (t.fillerSpoken || signal.aborted) return;
            t.fillerSpoken = true;
            speakAnnouncement(
              s,
              t.turnId,
              fillerCfg.text,
              fillerCfg.interruptible ?? D.fillerInterruptible,
            );
          }, fillerCfg.afterMs ?? D.fillerAfterMs);
        }
        let results: LlmToolResult[];
        try {
          results = await runTools(s, t, ctx, calls);
        } finally {
          if (filler) clearTimeout(filler);
          filler = undefined;
        }
        s.history.addToolResults(results, { turnId: t.turnId });
        if (signal.aborted)
          throw new LlmProviderError("LLM_ABORTED", "aborted");
      }
      t.status = "completed";
      return summarize(t);
    } catch (err) {
      if (signal.aborted) {
        if (t.roundOpen) {
          const text = (t.playedOverride ?? t.roundText).trim();
          if (text) {
            s.history.addAssistant(
              { role: "assistant", text },
              { turnId: t.turnId },
            );
          }
          t.roundOpen = false;
        }
        t.status = t.abortStatus ?? "cancelled";
        return summarize(t);
      }
      const code =
        err instanceof LlmProviderError ? err.code : "LLM_TURN_ERROR";
      t.errorCode = code;
      agentLog("error", `llm turn failed: ${code}`, s.sessionId);
      speakFallback(s, t);
      t.status = "failed";
      return summarize(t);
    } finally {
      if (filler) clearTimeout(filler);
    }
  }

  async function execute(
    s: SessionState,
    t: TurnState,
    ctx: TurnContext,
  ): Promise<void> {
    const note = useNote ? s.history.takePendingNote() : undefined;
    s.history.addUser(note ? `${note}\n${t.inputText}` : t.inputText, {
      turnId: t.turnId,
    });
    setAgentState(s.sessionId, "thinking");

    let summary: TurnSummary;
    let nextCalled = false;
    let nextSummary: TurnSummary | undefined;
    const next = async (): Promise<TurnSummary> => {
      nextCalled = true;
      nextSummary = await body(s, t, ctx);
      return nextSummary;
    };
    if (hooks.respond) {
      const r = await callHook("respond", s.sessionId, () =>
        hooks.respond!(ctx, next),
      );
      if (r.ok && r.value) {
        summary = r.value;
      } else if (nextSummary) {
        summary = nextSummary;
      } else if (!r.ok && !nextCalled) {
        summary = await next();
      } else {
        t.status =
          t.abortStatus ??
          (t.controller.signal.aborted ? "cancelled" : "completed");
        summary = summarize(t);
      }
    } else {
      summary = await next();
    }

    if (
      t.source === "chat" &&
      (summary.status === "completed" || summary.status === "failed")
    ) {
      const text = t.spoken.join(" ");
      sendToClient(s.sessionId, {
        type: "assistant_done",
        turnId: t.turnId,
        text,
      });
      sendToClient(s.sessionId, { type: "chat_reply", text });
    }
    setAgentState(s.sessionId, "listening");
    if (hooks.onTurnEnd) {
      await callHook("onTurnEnd", s.sessionId, () =>
        hooks.onTurnEnd!(summary, ctx),
      );
    }
    agentLog(
      "info",
      "llm turn",
      {
        turnId: summary.turnId,
        status: summary.status,
        llmCalls: summary.llmCalls,
        toolCalls: summary.toolCalls.map((c) => c.name),
        firstTokenMs: summary.firstTokenMs,
        inputTokens: summary.inputTokens,
        outputTokens: summary.outputTokens,
      },
      s.sessionId,
    );
  }

  function startTurn(s: SessionState, text: string, source: Source): void {
    const turnId = randomUUID();
    const controller = new AbortController();
    const t: TurnState = {
      turnId,
      source,
      inputText: text,
      controller,
      startedAt: now(),
      spoken: [],
      toolCalls: [],
      llmCalls: 0,
      roundOpen: false,
      roundText: "",
      spokeFirst: false,
      fillerSpoken: false,
      fallbackSpoken: false,
      status: "completed",
    };
    const ctx: TurnContext = {
      sessionId: s.sessionId,
      turnId,
      inputText: text,
      source,
      signal: controller.signal,
      speak: (speech, o) => {
        const splitter = new SentenceSplitter();
        const parts = [...splitter.push(`${speech}\n`), ...splitter.end()];
        for (const part of parts) deliver(s, t, part, o?.interruptible);
      },
    };
    const active: ActiveTurn = {
      turnId,
      state: t,
      promise: Promise.resolve(),
    };
    s.active = active;
    active.promise = (async () => {
      try {
        await execute(s, t, ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        agentLog("error", `llm turn crashed: ${message}`, s.sessionId);
      } finally {
        if (s.active === active) s.active = undefined;
        const q = s.queued;
        if (q && !s.ended && !s.active) {
          s.queued = undefined;
          startTurn(s, q.text, q.source);
        }
      }
    })();
  }

  async function handleInput(
    s: SessionState,
    text: string,
    source: Source,
  ): Promise<void> {
    if (s.ended) return;
    if (
      source === "voice" &&
      config.speechDuringNonInterruptible === "discard" &&
      s.announcing > 0
    ) {
      agentLog("info", "final discarded during announcement", s.sessionId);
      if (hooks.onTurnEnd) {
        const turnId = randomUUID();
        const summary: TurnSummary = {
          turnId,
          status: "discarded",
          assistantText: "",
          toolCalls: [],
          llmCalls: 0,
        };
        const ctx: TurnContext = {
          sessionId: s.sessionId,
          turnId,
          inputText: text,
          source,
          signal: new AbortController().signal,
          speak: () => {},
        };
        await callHook("onTurnEnd", s.sessionId, () =>
          hooks.onTurnEnd!(summary, ctx),
        );
      }
      return;
    }
    const active = s.active;
    if (active) {
      if (policy === "finish") {
        s.queued = { text, source };
        return;
      }
      cancelSpeech(s.sessionId, { turnId: active.turnId });
      active.state.abortStatus = "cancelled";
      active.state.controller.abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        active.promise,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, CANCEL_SETTLE_MS);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (s.ended) return;
    }
    startTurn(s, text, source);
  }

  /** Never awaits the LLM: the session's serial queue must stay free. */
  function submit(sessionId: string, text: string, source: Source): void {
    const s = sessions.get(sessionId);
    const trimmed = text.trim();
    if (!s || !trimmed) return;
    s.chain = s.chain
      .then(() => handleInput(s, trimmed, source))
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        agentLog("error", `llm input failed: ${message}`, sessionId);
      });
  }

  // ---- handlers ----------------------------------------------------------

  return {
    async onAgentStart() {
      const env = getEnv();
      const apiKey = env[config.apiKeySecret];
      if (!nonEmpty(apiKey)) {
        throw configError(
          `environment variable ${config.apiKeySecret} is not set`,
          "LLM_API_KEY_MISSING",
        );
      }
      if (!provider) {
        provider = createLlmProvider({
          provider: config.provider,
          apiKey,
          baseUrl: config.baseUrl,
        });
      }
      buildRegistry(env);
    },

    async onSessionStart(ctx: SessionContext) {
      const s: SessionState = {
        sessionId: ctx.sessionId,
        history: new ConversationHistory(historyTurns),
        announcing: 0,
        chain: Promise.resolve(),
        ended: false,
      };
      sessions.set(ctx.sessionId, s);
      const mode = config.bargeIn?.mode ?? D.bargeInMode;
      if (ctx.speakControlAvailable && (mode === "on" || mode === "off")) {
        await setBargeIn(ctx.sessionId, mode === "on");
      }
      const greeting = config.greeting;
      if (greeting) {
        const turnId = `greet-${randomUUID()}`;
        s.history.addAssistant(
          { role: "assistant", text: greeting.text },
          { turnId },
        );
        speakAnnouncement(
          s,
          turnId,
          greeting.text,
          greeting.interruptible ?? D.greetingInterruptible,
        );
      }
    },

    onUserSpeechFinal(ctx) {
      submit(ctx.sessionId, ctx.text, "voice");
    },

    onDataChannelMessage(ctx) {
      const text = parseChatText(ctx.message);
      if (text) submit(ctx.sessionId, text, "chat");
    },

    onAgentInterrupted(ctx: AgentInterruptedContext) {
      const s = sessions.get(ctx.sessionId);
      if (!s || !ctx.turnId) return;
      const note = useNote
        ? interruptionNote(ctx.playedText, ctx.unplayedText)
        : undefined;
      s.lastInterruption = {
        turnId: ctx.turnId,
        playedText: ctx.playedText,
        unplayedText: ctx.unplayedText,
      };
      const active = s.active;
      if (active && active.turnId === ctx.turnId) {
        const t = active.state;
        if (t.roundOpen) {
          t.playedOverride = ctx.playedText;
          if (note) s.history.setPendingNote(note);
        } else {
          s.history.replaceAssistantText(ctx.turnId, ctx.playedText, note);
        }
        if (policy === "cancel") {
          t.abortStatus = "interrupted";
          t.controller.abort();
        }
      } else {
        s.history.replaceAssistantText(ctx.turnId, ctx.playedText, note);
      }
    },

    onSessionEnd(ctx) {
      const s = sessions.get(ctx.sessionId);
      if (!s) return;
      s.ended = true;
      s.queued = undefined;
      if (s.active) {
        s.active.state.abortStatus = "cancelled";
        s.active.state.controller.abort();
      }
      sessions.delete(ctx.sessionId);
    },
  };
}
