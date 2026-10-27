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
import {
  DEFAULT_EMBEDDING_DIMS,
  DEFAULT_EMBEDDING_MODEL,
} from "../bounded-embedder.js";
import { createLlmEmbedder, createLlmProvider } from "../providers.js";
import {
  createRedisKnowledgeBase,
  createSupabaseKnowledgeBase,
  searchKnowledgeTool,
} from "../knowledge/index.js";
import type {
  KnowledgeBase,
  KnowledgeDocument,
  KnowledgeLogger,
} from "../knowledge/index.js";
import { McpToolSource } from "../mcp/mcp-tool-source.js";
import type { McpToolSourceOptions } from "../mcp/mcp-tool-source.js";
import { secretValuesFromEnv } from "./redact.js";
import { ToolRegistry } from "../mcp/tool-registry.js";
import type { CustomTool } from "../mcp/tool-registry.js";
import { LlmProviderError } from "../types.js";
import type {
  LlmMessage,
  LlmProvider,
  LlmProviderModule,
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
  /** Provider SDK modules this agent may use, e.g. `[openai]` from `@voicethere/agent/llm/openai`. Must include the one `config.provider` selects. */
  providers?: readonly LlmProviderModule[];
  now?: () => number;
  /** Test injection: random number in [0, 1) used to pick a filler phrase. */
  random?: () => number;
  /**
   * Retrieval for `config.knowledge`. `documents` are the chunks' source for
   * `store: "redis"` (import `knowledge/*.md` as strings). `base` replaces the
   * configured store (tests, advanced use).
   */
  knowledge?: {
    documents?: KnowledgeDocument[];
    base?: KnowledgeBase;
    /** Tests only: allow http://127.0.0.1 and http://localhost Supabase URLs. */
    allowInsecureLocal?: boolean;
  };
  /** Test injection for MCP tool sources. */
  sourceFactory?: (opts: McpToolSourceOptions) => McpToolSource;
}

type Source = "voice" | "chat";
type FillerKind = "thinking" | "toolCall" | "toolWait";

const MAX_FILLERS_PER_TURN = 3;
const MAX_TOOL_WAIT_FILLERS = 2;
const TOOL_CALL_GAP_MS = 2_000;
const COALESCE_MAX_CHARS = 400;

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
  /** Fillers from the `fillers` block spoken in this turn (cap 2). */
  fillersSpoken: number;
  thinkingSpoken: boolean;
  toolCallSpoken: boolean;
  toolWaitSpoken: number;
  lastFillerAt?: number;
  /** True once reply speech started after the last filler. */
  replySinceFiller: boolean;
  fillerTimers: Map<FillerKind, ReturnType<typeof setTimeout>>;
  /** Sentences completed but not yet spoken (speech coalescing). */
  pending: string[];
  pendingChars: number;
  coalesceTimer?: ReturnType<typeof setTimeout>;
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
  lastFillerPhrase?: string;
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
  if (
    !opts.provider &&
    !(opts.providers ?? []).some((m) => m.ids.includes(config.provider))
  ) {
    // Quotes are interpolated so the eject copy's import scan sees no specifier here.
    const sub = config.provider === "openrouter" ? "openai" : config.provider;
    const q = '"';
    throw configError(
      `voicethere.llm.json selects provider ${q}${config.provider}${q}, but agent.ts does not register it. Add: import { ${sub} } from ${q}@voicethere/agent/llm/${sub}${q}; and pass providers: [${sub}]`,
      "LLM_CONFIG_INVALID",
    );
  }
  const knowledgeCfg = config.knowledge;
  if (
    knowledgeCfg &&
    knowledgeCfg.store !== "off" &&
    knowledgeCfg.embeddings &&
    !opts.knowledge?.base &&
    !(opts.providers ?? []).some((m) =>
      m.ids.includes(knowledgeCfg.embeddings!.provider),
    )
  ) {
    const sub =
      knowledgeCfg.embeddings.provider === "openrouter"
        ? "openai"
        : knowledgeCfg.embeddings.provider;
    const q = '"';
    throw configError(
      `voicethere.llm.json knowledge.embeddings selects provider ${q}${knowledgeCfg.embeddings.provider}${q}, but agent.ts does not register it. Add: import { ${sub} } from ${q}@voicethere/agent/llm/${sub}${q}; and pass it in providers`,
      "LLM_CONFIG_INVALID",
    );
  }
  const hooks = opts.hooks ?? {};
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
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
  const fillerCfg = config.fillers;
  const thinkingPhrases = fillerCfg?.thinking?.phrases ?? [];
  const toolCallPhrases = fillerCfg?.toolCall?.phrases ?? [];
  const toolWaitPhrases = fillerCfg?.toolWait?.phrases ?? [];
  const thinkingAfterMs = fillerCfg?.thinking?.afterMs ?? D.thinkingAfterMs;
  const toolWaitAfterMs = fillerCfg?.toolWait?.afterMs ?? D.toolWaitAfterMs;
  const fillersInterruptible =
    fillerCfg?.interruptible ?? D.fillersInterruptible;
  const coalesceMs = config.speech?.coalesceMs ?? D.speechCoalesceMs;
  const legacyToolFiller =
    toolCallPhrases.length === 0 && toolWaitPhrases.length === 0
      ? config.tools?.filler
      : undefined;

  let provider: LlmProvider | undefined = opts.provider;
  let knowledgeTool: CustomTool | undefined;
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
    flushSpeech(s, t);
    t.spoken.push(text);
    markReplyStarted(s, t);
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

  // ---- fillers -----------------------------------------------------------

  function clearFillerTimer(t: TurnState, kind?: FillerKind): void {
    for (const [k, timer] of t.fillerTimers) {
      if (kind && k !== kind) continue;
      clearTimeout(timer);
      t.fillerTimers.delete(k);
    }
  }

  function phrasesFor(kind: FillerKind): string[] {
    return kind === "thinking"
      ? thinkingPhrases
      : kind === "toolCall"
        ? toolCallPhrases
        : toolWaitPhrases;
  }

  function pickFiller(s: SessionState, kind: FillerKind): string {
    const all = phrasesFor(kind);
    const pool =
      all.length > 1 ? all.filter((p) => p !== s.lastFillerPhrase) : all;
    const i = Math.min(pool.length - 1, Math.floor(random() * pool.length));
    return pool[i];
  }

  /**
   * Speaks a filler of `kind` now, unless the turn's limits say no. Returns
   * the ms to wait when the gap to the previous filler is too short.
   */
  function tryFiller(
    s: SessionState,
    t: TurnState,
    kind: FillerKind,
    afterMs: number,
  ): { wait: number } | undefined {
    if (t.controller.signal.aborted || s.ended) return undefined;
    if (t.source === "chat" && !speakChat) return undefined;
    if (phrasesFor(kind).length === 0) return undefined;
    if (t.fillersSpoken >= MAX_FILLERS_PER_TURN) return undefined;
    if (kind === "thinking" && (t.thinkingSpoken || t.spokeFirst)) {
      return undefined;
    }
    if (kind === "toolCall" && (t.toolCallSpoken || t.spokeFirst)) {
      return undefined;
    }
    if (kind === "toolWait" && t.toolWaitSpoken >= MAX_TOOL_WAIT_FILLERS) {
      return undefined;
    }
    if (t.lastFillerAt !== undefined && !t.replySinceFiller) {
      const gap = kind === "toolCall" ? TOOL_CALL_GAP_MS : afterMs;
      const rest = gap - (now() - t.lastFillerAt);
      if (rest > 0) return kind === "toolCall" ? undefined : { wait: rest };
    }
    const text = pickFiller(s, kind);
    s.lastFillerPhrase = text;
    t.fillersSpoken += 1;
    t.lastFillerAt = now();
    t.replySinceFiller = false;
    if (kind === "thinking") t.thinkingSpoken = true;
    if (kind === "toolCall") t.toolCallSpoken = true;
    if (kind === "toolWait") t.toolWaitSpoken += 1;
    speakAnnouncement(s, t.turnId, text, fillersInterruptible);
    return undefined;
  }

  function armFiller(
    s: SessionState,
    t: TurnState,
    kind: FillerKind,
    delayMs: number,
    afterMs: number,
  ): void {
    if (phrasesFor(kind).length === 0 || s.ended) return;
    clearFillerTimer(t, kind);
    const timer = setTimeout(() => {
      t.fillerTimers.delete(kind);
      const r = tryFiller(s, t, kind, afterMs);
      if (r) armFiller(s, t, kind, r.wait, afterMs);
    }, delayMs);
    t.fillerTimers.set(kind, timer);
  }

  // ---- speech coalescing -------------------------------------------------

  function dropPending(t: TurnState): void {
    if (t.coalesceTimer) clearTimeout(t.coalesceTimer);
    t.coalesceTimer = undefined;
    t.pending = [];
    t.pendingChars = 0;
  }

  /** Speaks the buffered sentences as one utterance. */
  function flushSpeech(s: SessionState, t: TurnState): void {
    if (t.coalesceTimer) clearTimeout(t.coalesceTimer);
    t.coalesceTimer = undefined;
    if (t.pending.length === 0) return;
    const text = t.pending.join(" ");
    t.pending = [];
    t.pendingChars = 0;
    if (t.controller.signal.aborted || s.ended) return;
    speak(s.sessionId, text, { turnId: t.turnId });
  }

  /** A sentence of the model's reply: chat delta now, speech coalesced. */
  function deliverReply(s: SessionState, t: TurnState, text: string): void {
    if (coalesceMs <= 0) {
      deliver(s, t, text);
      return;
    }
    markReplyStarted(s, t);
    t.spoken.push(text);
    if (t.source === "chat") {
      sendToClient(s.sessionId, {
        type: "assistant_delta",
        turnId: t.turnId,
        text,
      });
    }
    if (t.source !== "voice" && !speakChat) return;
    t.pending.push(text);
    t.pendingChars += text.length;
    if (t.pendingChars >= COALESCE_MAX_CHARS) {
      flushSpeech(s, t);
    } else if (!t.coalesceTimer) {
      t.coalesceTimer = setTimeout(() => {
        t.coalesceTimer = undefined;
        flushSpeech(s, t);
      }, coalesceMs);
    }
  }

  function markReplyStarted(s: SessionState, t: TurnState): void {
    t.replySinceFiller = true;
    if (!t.spokeFirst) {
      t.spokeFirst = true;
      clearFillerTimer(t, "thinking");
      setAgentState(s.sessionId, "speaking");
    }
  }

  // ---- tools -------------------------------------------------------------

  /** Content-free: fields hold counts, ids and durations only. */
  const knowledgeLogger: KnowledgeLogger = {
    info: (message, fields) => agentLog("info", message, fields ?? {}),
  };

  function buildKnowledge(env: Record<string, string | undefined>): void {
    const kc = config.knowledge;
    if (!kc || kc.store === "off") return;
    const injected = opts.knowledge?.base;
    const topK = kc.topK ?? 4;
    const logCode = (message: string, fields?: Record<string, unknown>) =>
      agentLog("warn", message, fields ?? {});
    let base = injected;
    if (!base) {
      const emb = kc.embeddings;
      if (!emb) return;
      const apiKey = env[emb.apiKeySecret];
      if (!nonEmpty(apiKey)) {
        agentLog(
          "warn",
          `knowledge: ${emb.apiKeySecret} is not set, search_knowledge disabled`,
        );
        return;
      }
      const model =
        emb.model ??
        (emb.provider === "openai" || emb.provider === "gemini"
          ? DEFAULT_EMBEDDING_MODEL[emb.provider]
          : undefined);
      if (!model) return;
      const dims = emb.dimensions ?? DEFAULT_EMBEDDING_DIMS;
      const redisUrl = env.AGENT_REDIS_URL;
      if (kc.store === "redis") {
        if (!nonEmpty(redisUrl)) {
          agentLog(
            "info",
            "knowledge: AGENT_REDIS_URL unset (enable Project Redis)",
          );
          return;
        }
        const documents = opts.knowledge?.documents ?? [];
        if (documents.length === 0) {
          agentLog(
            "info",
            "knowledge: no documents, search_knowledge disabled",
          );
          return;
        }
        base = createRedisKnowledgeBase({
          redisUrl,
          namespace: kc.redis?.namespace,
          documents,
          embedder: createLlmEmbedder(
            { provider: emb.provider, apiKey },
            opts.providers ?? [],
          ),
          model,
          dims,
          logger: knowledgeLogger,
        });
      } else {
        const sb = kc.supabase;
        const url = sb ? env[sb.urlSecret] : undefined;
        const key = sb ? env[sb.keySecret] : undefined;
        if (!sb || !nonEmpty(url) || !nonEmpty(key)) {
          agentLog(
            "info",
            "knowledge: Supabase URL or key secret is not set, search_knowledge disabled",
          );
          return;
        }
        if (!/^https:\/\//i.test(url.trim())) {
          const local = /^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(
            url.trim(),
          );
          if (!local || !opts.knowledge?.allowInsecureLocal) {
            agentLog(
              "info",
              "knowledge: supabase url must use https; knowledge search disabled",
            );
            return;
          }
        }
        base = createSupabaseKnowledgeBase({
          allowInsecureLocal: opts.knowledge?.allowInsecureLocal,
          url,
          key,
          rpc: sb.rpc,
          matchThreshold: sb.matchThreshold,
          embedder: createLlmEmbedder(
            { provider: emb.provider, apiKey },
            opts.providers ?? [],
          ),
          model,
          dims,
          cache: nonEmpty(redisUrl)
            ? {
                redisUrl,
                ttlSeconds: sb.cacheTtlSeconds,
                namespace: kc.redis?.namespace,
              }
            : undefined,
          logger: knowledgeLogger,
        });
      }
    }
    // The agent runtime has no shutdown hook: the connection is closed with the process.
    // Indexing never blocks agent start; search retries the index on demand.
    void base.ensureIndexed().then(
      (report) =>
        agentLog("info", "knowledge indexed", {
          status: report.status,
          chunks: report.chunks,
          waitedMs: report.waitedMs,
        }),
      (err: unknown) =>
        agentLog("warn", "knowledge indexing failed", {
          code:
            typeof (err as { code?: unknown })?.code === "string"
              ? (err as { code: string }).code
              : "KB_UNKNOWN",
        }),
    );
    knowledgeTool = searchKnowledgeTool(base, { topK, log: logCode });
  }

  function buildRegistry(env: Record<string, string | undefined>): void {
    const reg = new ToolRegistry({
      log: (level, message, fields) => agentLog(level, message, fields ?? {}),
      toolCallLog: {
        mode: config.toolCallLogs ?? D.toolCallLogs,
        secretValues: secretValuesFromEnv(env, [
          config.apiKeySecret,
          "AGENT_SERVICE_TOKEN",
          ...(config.knowledge?.embeddings
            ? [config.knowledge.embeddings.apiKeySecret]
            : []),
          ...(config.knowledge?.supabase
            ? [
                config.knowledge.supabase.keySecret,
                config.knowledge.supabase.urlSecret,
              ]
            : []),
          ...(config.toolSources ?? []).flatMap((src) => {
            if (src.kind !== "mcp" || !src.auth) return [];
            if (src.auth.type === "bearer") return [src.auth.secret];
            if (src.auth.type === "headers")
              return Object.values(src.auth.headers);
            return [];
          }),
        ]),
        emit: (fields, sid) =>
          agentLog("info", "llm tool call", { ...fields }, sid),
      },
    });
    for (const tool of opts.tools ?? []) reg.addCustomTool(tool);
    if (knowledgeTool) reg.addCustomTool(knowledgeTool);
    const sources: McpToolSource[] = [];
    for (const src of config.toolSources ?? []) {
      if (src.kind === "service") {
        const base = env.AGENT_SERVICE_URL;
        if (!nonEmpty(base)) {
          agentLog(
            "warn",
            "toolSources: service configured but this project has no service",
          );
          continue;
        }
        const headers: Record<string, string> = {};
        const token = env.AGENT_SERVICE_TOKEN;
        if (nonEmpty(token)) {
          headers.Authorization = `Bearer ${token}`;
        } else {
          agentLog("warn", "toolSources: AGENT_SERVICE_TOKEN is not set");
        }
        const source = makeSource({
          name: "service",
          kind: "service",
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
        const hookStart = Date.now();
        const hooked = hooks.onToolCall
          ? await callHook("onToolCall", s.sessionId, () =>
              hooks.onToolCall!({ name: call.name, args: call.input }, ctx),
            )
          : undefined;
        if (hooked?.ok && hooked.value) {
          const answered = {
            content: String(hooked.value.result),
            isError: hooked.value.isError === true,
          };
          registry?.logExternalCall(
            call.name,
            call.input,
            {
              timeoutMs: toolTimeoutMs,
              sessionId: s.sessionId,
              turnId: t.turnId,
              callId: call.id,
            },
            hookStart,
            Date.now(),
            answered,
          );
          return answered;
        }
        if (!registry) return { content: "no tools available", isError: true };
        return registry.call(call.name, call.input, {
          signal,
          timeoutMs: toolTimeoutMs,
          sessionId: s.sessionId,
          turnId: t.turnId,
          callId: call.id,
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
    deliverReply(s, t, out);
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
    if (t.llmCalls === 1 && !t.spokeFirst) {
      armFiller(s, t, "thinking", thinkingAfterMs, thinkingAfterMs);
    }
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
    flushSpeech(s, t);
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
        clearFillerTimer(t, "thinking");
        tryFiller(s, t, "toolCall", 0);
        armFiller(s, t, "toolWait", toolWaitAfterMs, toolWaitAfterMs);
        const fillerLegacy = legacyToolFiller;
        if (fillerLegacy && !t.fillerSpoken) {
          filler = setTimeout(() => {
            if (t.fillerSpoken || signal.aborted) return;
            t.fillerSpoken = true;
            speakAnnouncement(
              s,
              t.turnId,
              fillerLegacy.text,
              fillerLegacy.interruptible ?? D.fillerInterruptible,
            );
          }, fillerLegacy.afterMs ?? D.fillerAfterMs);
        }
        let results: LlmToolResult[];
        try {
          results = await runTools(s, t, ctx, calls);
        } finally {
          if (filler) clearTimeout(filler);
          filler = undefined;
          clearFillerTimer(t);
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
      clearFillerTimer(t);
      if (signal.aborted) dropPending(t);
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
      fillersSpoken: 0,
      thinkingSpoken: false,
      toolCallSpoken: false,
      toolWaitSpoken: 0,
      replySinceFiller: false,
      fillerTimers: new Map(),
      pending: [],
      pendingChars: 0,
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
      clearFillerTimer(active.state);
      dropPending(active.state);
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
      for (const w of validated.warnings) {
        agentLog("warn", `config warning: ${w.path} ${w.message}`);
      }
      const env = getEnv();
      const apiKey = env[config.apiKeySecret];
      if (!nonEmpty(apiKey)) {
        throw configError(
          `environment variable ${config.apiKeySecret} is not set`,
          "LLM_API_KEY_MISSING",
        );
      }
      if (!provider) {
        provider = createLlmProvider(
          {
            provider: config.provider,
            apiKey,
            baseUrl: config.baseUrl,
          },
          opts.providers ?? [],
        );
      }
      buildKnowledge(env);
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
        clearFillerTimer(t);
        dropPending(t);
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
        clearFillerTimer(s.active.state);
        dropPending(s.active.state);
      }
      sessions.delete(ctx.sessionId);
    },
  };
}
