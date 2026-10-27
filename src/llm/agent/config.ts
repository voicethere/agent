import type { LlmProviderId } from "../types.js";

export interface LlmAgentGreeting {
  text: string;
  /** Default false: the greeting is announced and the caller cannot cut it. */
  interruptible?: boolean;
}

/**
 * @deprecated Use the top-level `fillers` block. Ignored when `fillers` is set.
 */
export interface LlmAgentToolFiller {
  text: string;
  afterMs?: number;
  interruptible?: boolean;
}

/** One situation of the `fillers` block. Absent or empty `phrases` turns it off. */
export interface LlmAgentFillerSituation {
  phrases: string[];
  /** Wait before the filler. `thinking` 300..10000 (default 1500), `toolWait` 1000..30000 (default 4000). Unused by `toolCall`. */
  afterMs?: number;
}

/** Short sentences spoken while the caller waits. Off when absent. */
export interface LlmAgentFillers {
  /** The caller waits for the first sentence of the model's reply. Phrases up to 60 characters. */
  thinking?: LlmAgentFillerSituation;
  /** The model requested a tool call and has said nothing yet. Phrases up to 120 characters. */
  toolCall?: LlmAgentFillerSituation;
  /** A tool round is still running. Phrases up to 120 characters. */
  toolWait?: LlmAgentFillerSituation;
  /** Default true: barge-in may cut a filler. */
  interruptible?: boolean;
}

export interface LlmAgentToolsConfig {
  maxRounds?: number;
  timeoutMs?: number;
  maxResultBytes?: number;
  /** @deprecated Use the top-level `fillers` block. */
  filler?: LlmAgentToolFiller;
}

export type LlmAgentMcpAuth =
  | { type: "none" }
  | { type: "bearer"; secret: string }
  | { type: "headers"; headers: Record<string, string> };

export interface LlmAgentServiceSource {
  kind: "service";
  path?: string;
  allow?: string[];
  deny?: string[];
}

export interface LlmAgentMcpSource {
  kind: "mcp";
  name: string;
  url: string;
  auth?: LlmAgentMcpAuth;
  allow?: string[];
  deny?: string[];
}

export type LlmAgentToolSource = LlmAgentServiceSource | LlmAgentMcpSource;

export interface LlmAgentConfig {
  version: 1;
  provider: LlmProviderId;
  model?: string;
  /** Name of the environment variable that holds the API key. */
  apiKeySecret: string;
  baseUrl?: string;
  temperature?: number;
  maxOutputTokens?: number;
  greeting?: LlmAgentGreeting;
  bargeIn?: { mode: "project" | "on" | "off" };
  speechDuringNonInterruptible?: "answer_after" | "discard";
  history?: { turns?: number; interruptionNote?: boolean };
  tools?: LlmAgentToolsConfig;
  fillers?: LlmAgentFillers;
  speech?: { coalesceMs?: number };
  toolSources?: LlmAgentToolSource[];
  interruptPolicy?: "cancel" | "finish";
  serviceWaitMs?: number;
  fallbackText?: string;
  speakChatReplies?: boolean;
  /** Tool-call log lines: `redacted` (default), `full` (secrets still removed) or `off`. */
  toolCallLogs?: "full" | "redacted" | "off";
}

export const LLM_AGENT_CONFIG_DEFAULTS = {
  maxOutputTokens: 512,
  greetingInterruptible: false,
  bargeInMode: "project",
  speechDuringNonInterruptible: "answer_after",
  historyTurns: 20,
  interruptionNote: true,
  toolMaxRounds: 5,
  toolTimeoutMs: 15_000,
  toolMaxResultBytes: 16_384,
  fillerAfterMs: 1_500,
  fillerInterruptible: false,
  thinkingAfterMs: 1_500,
  toolWaitAfterMs: 4_000,
  fillersInterruptible: true,
  speechCoalesceMs: 150,
  servicePath: "/mcp",
  interruptPolicy: "cancel",
  serviceWaitMs: 20_000,
  fallbackText: "Sorry, something went wrong. Please try again.",
  speakChatReplies: true,
  toolCallLogs: "redacted",
} as const;

export interface LlmAgentConfigError {
  path: string;
  message: string;
}

export type LlmAgentConfigResult =
  | { ok: true; config: LlmAgentConfig; warnings: LlmAgentConfigError[] }
  | { ok: false; errors: LlmAgentConfigError[] };

const PROVIDER_IDS = ["openai", "anthropic", "gemini", "openrouter"] as const;
const ENV_NAME_RE = /^AGENT_[A-Z0-9_]{1,57}$/;
const ENV_NAME_MESSAGE =
  "must start with AGENT_ (only AGENT_* project secrets reach the agent)";
const SOURCE_NAME_RE = /^[a-z0-9-]{1,40}$/;
const MAX_SOURCES = 8;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (!h.includes(":")) return false;
  if (h === "::1" || h === "::") return true;
  const first = h.split(":")[0];
  if (first && /^f[cd][0-9a-f]{2}$/.test(first)) return true;
  // IPv4-mapped ::ffff:a.b.c.d, normalised by URL to ::ffff:hhhh:hhhh
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (mapped) {
    const hi = parseInt(mapped[1], 16);
    const lo = parseInt(mapped[2], 16);
    return isPrivateIpv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return false;
}

/** Returns an error message when `host` is a local or private address literal. */
function privateHostReason(hostname: string): string | undefined {
  const host =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) {
    return "host must not be localhost";
  }
  if (isPrivateIpv4(lower) || isPrivateIpv6(lower)) {
    return "host must not be a private or loopback address";
  }
  return undefined;
}

class Checker {
  readonly errors: LlmAgentConfigError[] = [];

  err(path: string, message: string): void {
    this.errors.push({ path, message });
  }

  unknownKeys(
    obj: Record<string, unknown>,
    allowed: readonly string[],
    path: string,
  ): void {
    for (const key of Object.keys(obj)) {
      if (!allowed.includes(key)) {
        this.err(path ? `${path}.${key}` : key, "unknown field");
      }
    }
  }

  object(v: unknown, path: string): Record<string, unknown> | undefined {
    if (!isRecord(v)) {
      this.err(path, "must be an object");
      return undefined;
    }
    return v;
  }

  string(
    v: unknown,
    path: string,
    opts: { min?: number; max?: number; re?: RegExp; reMessage?: string } = {},
  ): string | undefined {
    if (typeof v !== "string") {
      this.err(path, "must be a string");
      return undefined;
    }
    if (opts.min !== undefined && v.length < opts.min) {
      this.err(path, `must be at least ${opts.min} characters`);
      return undefined;
    }
    if (opts.max !== undefined && v.length > opts.max) {
      this.err(path, `must be at most ${opts.max} characters`);
      return undefined;
    }
    if (opts.re && !opts.re.test(v)) {
      this.err(path, opts.reMessage ?? `must match ${opts.re.source}`);
      return undefined;
    }
    return v;
  }

  number(
    v: unknown,
    path: string,
    min: number,
    max: number,
    integer: boolean,
  ): number | undefined {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      this.err(path, "must be a number");
      return undefined;
    }
    if (integer && !Number.isInteger(v)) {
      this.err(path, "must be an integer");
      return undefined;
    }
    if (v < min || v > max) {
      this.err(path, `must be between ${min} and ${max}`);
      return undefined;
    }
    return v;
  }

  boolean(v: unknown, path: string): boolean | undefined {
    if (typeof v !== "boolean") {
      this.err(path, "must be a boolean");
      return undefined;
    }
    return v;
  }

  stringList(v: unknown, path: string): string[] | undefined {
    if (!Array.isArray(v)) {
      this.err(path, "must be an array of strings");
      return undefined;
    }
    const out: string[] = [];
    v.forEach((item, i) => {
      const s = this.string(item, `${path}[${i}]`, { min: 1, max: 128 });
      if (s !== undefined) out.push(s);
    });
    return out;
  }
}

function checkAuth(
  c: Checker,
  v: unknown,
  path: string,
): LlmAgentMcpAuth | undefined {
  const o = c.object(v, path);
  if (!o) return undefined;
  const type = o.type;
  if (type === "none") {
    c.unknownKeys(o, ["type"], path);
    return { type: "none" };
  }
  if (type === "bearer") {
    c.unknownKeys(o, ["type", "secret"], path);
    const secret = c.string(o.secret, `${path}.secret`, {
      re: ENV_NAME_RE,
      reMessage: ENV_NAME_MESSAGE,
    });
    return secret === undefined ? undefined : { type: "bearer", secret };
  }
  if (type === "headers") {
    c.unknownKeys(o, ["type", "headers"], path);
    const h = c.object(o.headers, `${path}.headers`);
    if (!h) return undefined;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(h)) {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) {
        c.err(`${path}.headers.${name}`, "invalid header name");
        continue;
      }
      const env = c.string(value, `${path}.headers.${name}`, {
        re: ENV_NAME_RE,
        reMessage: ENV_NAME_MESSAGE,
      });
      if (env !== undefined) headers[name] = env;
    }
    return { type: "headers", headers };
  }
  c.err(`${path}.type`, 'must be one of "none", "bearer", "headers"');
  return undefined;
}

function checkMcpUrl(c: Checker, v: unknown, path: string): string | undefined {
  const s = c.string(v, path, { min: 1, max: 2048 });
  if (s === undefined) return undefined;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    c.err(path, "must be a valid URL");
    return undefined;
  }
  if (u.protocol !== "https:") {
    c.err(path, "must use https");
    return undefined;
  }
  const reason = privateHostReason(u.hostname);
  if (reason) {
    c.err(path, reason);
    return undefined;
  }
  return s;
}

function checkSources(c: Checker, v: unknown, path: string) {
  if (!Array.isArray(v)) {
    c.err(path, "must be an array");
    return undefined;
  }
  if (v.length > MAX_SOURCES) {
    c.err(path, `must have at most ${MAX_SOURCES} entries`);
  }
  const out: LlmAgentToolSource[] = [];
  const names = new Set<string>();
  let services = 0;
  v.forEach((item, i) => {
    const p = `${path}[${i}]`;
    const o = c.object(item, p);
    if (!o) return;
    if (o.kind === "service") {
      c.unknownKeys(o, ["kind", "path", "allow", "deny"], p);
      services += 1;
      if (services > 1) c.err(p, "at most one service source is allowed");
      const src: LlmAgentServiceSource = { kind: "service" };
      if (o.path !== undefined) {
        const sp = c.string(o.path, `${p}.path`, { min: 1, max: 256 });
        if (sp !== undefined) {
          if (!sp.startsWith("/")) c.err(`${p}.path`, 'must start with "/"');
          else src.path = sp;
        }
      }
      if (o.allow !== undefined)
        src.allow = c.stringList(o.allow, `${p}.allow`);
      if (o.deny !== undefined) src.deny = c.stringList(o.deny, `${p}.deny`);
      out.push(src);
    } else if (o.kind === "mcp") {
      c.unknownKeys(o, ["kind", "name", "url", "auth", "allow", "deny"], p);
      const name = c.string(o.name, `${p}.name`, {
        re: SOURCE_NAME_RE,
        reMessage: "must match ^[a-z0-9-]{1,40}$",
      });
      if (name !== undefined) {
        if (names.has(name)) c.err(`${p}.name`, "must be unique");
        names.add(name);
      }
      const url = checkMcpUrl(c, o.url, `${p}.url`);
      const src: LlmAgentMcpSource = {
        kind: "mcp",
        name: name ?? "",
        url: url ?? "",
      };
      if (o.auth !== undefined) {
        const auth = checkAuth(c, o.auth, `${p}.auth`);
        if (auth) src.auth = auth;
      }
      if (o.allow !== undefined)
        src.allow = c.stringList(o.allow, `${p}.allow`);
      if (o.deny !== undefined) src.deny = c.stringList(o.deny, `${p}.deny`);
      out.push(src);
    } else {
      c.err(`${p}.kind`, 'must be "service" or "mcp"');
    }
  });
  return out;
}

const TOP_KEYS = [
  "$schema",
  "version",
  "provider",
  "model",
  "apiKeySecret",
  "baseUrl",
  "temperature",
  "maxOutputTokens",
  "greeting",
  "bargeIn",
  "speechDuringNonInterruptible",
  "history",
  "tools",
  "fillers",
  "speech",
  "toolSources",
  "interruptPolicy",
  "serviceWaitMs",
  "fallbackText",
  "speakChatReplies",
  "toolCallLogs",
] as const;

export function validateLlmAgentConfig(input: unknown): LlmAgentConfigResult {
  const c = new Checker();
  const root = c.object(input, "");
  if (!root) {
    return { ok: false, errors: [{ path: "", message: "must be an object" }] };
  }
  c.unknownKeys(root, TOP_KEYS, "");

  if (root.version !== 1) c.err("version", "must be 1");

  let provider: LlmProviderId | undefined;
  if (
    typeof root.provider === "string" &&
    (PROVIDER_IDS as readonly string[]).includes(root.provider)
  ) {
    provider = root.provider as LlmProviderId;
  } else {
    c.err("provider", `must be one of ${PROVIDER_IDS.join(", ")}`);
  }

  const config: Partial<LlmAgentConfig> = { version: 1 };
  if (provider) config.provider = provider;

  if (root.model !== undefined) {
    const m = c.string(root.model, "model", { min: 1, max: 200 });
    if (m !== undefined) config.model = m;
  }
  const secret = c.string(root.apiKeySecret, "apiKeySecret", {
    re: ENV_NAME_RE,
    reMessage: ENV_NAME_MESSAGE,
  });
  if (secret !== undefined) config.apiKeySecret = secret;

  if (root.baseUrl !== undefined) {
    const b = c.string(root.baseUrl, "baseUrl", { min: 1, max: 2048 });
    if (b !== undefined) {
      if (provider !== undefined && provider !== "openai") {
        c.err("baseUrl", 'is only allowed when provider is "openai"');
      } else {
        try {
          const u = new URL(b);
          if (u.protocol !== "http:" && u.protocol !== "https:") {
            c.err("baseUrl", "must use http or https");
          } else {
            config.baseUrl = b;
          }
        } catch {
          c.err("baseUrl", "must be a valid URL");
        }
      }
    }
  }

  if (root.temperature !== undefined) {
    const t = c.number(root.temperature, "temperature", 0, 2, false);
    if (t !== undefined) config.temperature = t;
  }
  if (root.maxOutputTokens !== undefined) {
    const t = c.number(root.maxOutputTokens, "maxOutputTokens", 1, 8192, true);
    if (t !== undefined) config.maxOutputTokens = t;
  }

  if (root.greeting !== undefined) {
    const g = c.object(root.greeting, "greeting");
    if (g) {
      c.unknownKeys(g, ["text", "interruptible"], "greeting");
      const text = c.string(g.text, "greeting.text", { min: 1, max: 500 });
      const greeting: Partial<LlmAgentGreeting> = {};
      if (text !== undefined) greeting.text = text;
      if (g.interruptible !== undefined) {
        const b = c.boolean(g.interruptible, "greeting.interruptible");
        if (b !== undefined) greeting.interruptible = b;
      }
      if (text !== undefined) config.greeting = greeting as LlmAgentGreeting;
    }
  }

  if (root.bargeIn !== undefined) {
    const b = c.object(root.bargeIn, "bargeIn");
    if (b) {
      c.unknownKeys(b, ["mode"], "bargeIn");
      if (b.mode === "project" || b.mode === "on" || b.mode === "off") {
        config.bargeIn = { mode: b.mode };
      } else {
        c.err("bargeIn.mode", 'must be one of "project", "on", "off"');
      }
    }
  }

  if (root.speechDuringNonInterruptible !== undefined) {
    const v = root.speechDuringNonInterruptible;
    if (v === "answer_after" || v === "discard") {
      config.speechDuringNonInterruptible = v;
    } else {
      c.err(
        "speechDuringNonInterruptible",
        'must be one of "answer_after", "discard"',
      );
    }
  }

  if (root.history !== undefined) {
    const h = c.object(root.history, "history");
    if (h) {
      c.unknownKeys(h, ["turns", "interruptionNote"], "history");
      const history: NonNullable<LlmAgentConfig["history"]> = {};
      if (h.turns !== undefined) {
        const t = c.number(h.turns, "history.turns", 1, 100, true);
        if (t !== undefined) history.turns = t;
      }
      if (h.interruptionNote !== undefined) {
        const b = c.boolean(h.interruptionNote, "history.interruptionNote");
        if (b !== undefined) history.interruptionNote = b;
      }
      config.history = history;
    }
  }

  if (root.tools !== undefined) {
    const t = c.object(root.tools, "tools");
    if (t) {
      c.unknownKeys(
        t,
        ["maxRounds", "timeoutMs", "maxResultBytes", "filler"],
        "tools",
      );
      const tools: LlmAgentToolsConfig = {};
      if (t.maxRounds !== undefined) {
        const n = c.number(t.maxRounds, "tools.maxRounds", 1, 10, true);
        if (n !== undefined) tools.maxRounds = n;
      }
      if (t.timeoutMs !== undefined) {
        const n = c.number(t.timeoutMs, "tools.timeoutMs", 1000, 60000, true);
        if (n !== undefined) tools.timeoutMs = n;
      }
      if (t.maxResultBytes !== undefined) {
        const n = c.number(
          t.maxResultBytes,
          "tools.maxResultBytes",
          1024,
          65536,
          true,
        );
        if (n !== undefined) tools.maxResultBytes = n;
      }
      if (t.filler !== undefined) {
        const f = c.object(t.filler, "tools.filler");
        if (f) {
          c.unknownKeys(
            f,
            ["text", "afterMs", "interruptible"],
            "tools.filler",
          );
          const text = c.string(f.text, "tools.filler.text", {
            min: 1,
            max: 500,
          });
          const filler: Partial<LlmAgentToolFiller> = {};
          if (text !== undefined) filler.text = text;
          if (f.afterMs !== undefined) {
            const n = c.number(
              f.afterMs,
              "tools.filler.afterMs",
              500,
              10000,
              true,
            );
            if (n !== undefined) filler.afterMs = n;
          }
          if (f.interruptible !== undefined) {
            const b = c.boolean(f.interruptible, "tools.filler.interruptible");
            if (b !== undefined) filler.interruptible = b;
          }
          if (text !== undefined) tools.filler = filler as LlmAgentToolFiller;
        }
      }
      config.tools = tools;
    }
  }

  const warnings: LlmAgentConfigError[] = [];
  if (root.fillers !== undefined) {
    const f = c.object(root.fillers, "fillers");
    if (f) {
      c.unknownKeys(
        f,
        ["thinking", "toolCall", "toolWait", "interruptible"],
        "fillers",
      );
      const fillers: LlmAgentFillers = {};
      const situations = [
        ["thinking", 60, [300, 10000]],
        ["toolCall", 120, undefined],
        ["toolWait", 120, [1000, 30000]],
      ] as const;
      for (const [key, maxChars, range] of situations) {
        if (f[key] === undefined) continue;
        const path = `fillers.${key}`;
        const o = c.object(f[key], path);
        if (!o) continue;
        c.unknownKeys(o, range ? ["phrases", "afterMs"] : ["phrases"], path);
        const sit: LlmAgentFillerSituation = { phrases: [] };
        if (o.phrases !== undefined) {
          if (!Array.isArray(o.phrases)) {
            c.err(`${path}.phrases`, "must be an array of strings");
          } else if (o.phrases.length > 20) {
            c.err(`${path}.phrases`, "must have at most 20 entries");
          } else {
            o.phrases.forEach((item, i) => {
              const p = `${path}.phrases[${i}]`;
              if (typeof item !== "string") {
                c.err(p, "must be a string");
                return;
              }
              const text = item.trim();
              if (text.length < 1) c.err(p, "must be at least 1 character");
              else if (text.length > maxChars) {
                c.err(p, `must be at most ${maxChars} characters`);
              } else sit.phrases.push(text);
            });
          }
        }
        if (range && o.afterMs !== undefined) {
          const n = c.number(
            o.afterMs,
            `${path}.afterMs`,
            range[0],
            range[1],
            true,
          );
          if (n !== undefined) sit.afterMs = n;
        }
        fillers[key] = sit;
      }
      if (f.interruptible !== undefined) {
        const b = c.boolean(f.interruptible, "fillers.interruptible");
        if (b !== undefined) fillers.interruptible = b;
      }
      config.fillers = fillers;
      if (
        ((fillers.toolCall?.phrases.length ?? 0) > 0 ||
          (fillers.toolWait?.phrases.length ?? 0) > 0) &&
        isRecord(root.tools) &&
        root.tools.filler !== undefined
      ) {
        warnings.push({
          path: "tools.filler",
          message:
            "is ignored because fillers.toolCall or fillers.toolWait is set; move the text into fillers.toolWait.phrases",
        });
      }
    }
  }

  if (root.speech !== undefined) {
    const sp = c.object(root.speech, "speech");
    if (sp) {
      c.unknownKeys(sp, ["coalesceMs"], "speech");
      const speech: NonNullable<LlmAgentConfig["speech"]> = {};
      if (sp.coalesceMs !== undefined) {
        const n = c.number(sp.coalesceMs, "speech.coalesceMs", 0, 1000, true);
        if (n !== undefined) speech.coalesceMs = n;
      }
      config.speech = speech;
    }
  }

  if (root.toolSources !== undefined) {
    const s = checkSources(c, root.toolSources, "toolSources");
    if (s) config.toolSources = s;
  }

  if (root.interruptPolicy !== undefined) {
    if (
      root.interruptPolicy === "cancel" ||
      root.interruptPolicy === "finish"
    ) {
      config.interruptPolicy = root.interruptPolicy;
    } else {
      c.err("interruptPolicy", 'must be one of "cancel", "finish"');
    }
  }
  if (root.serviceWaitMs !== undefined) {
    const n = c.number(root.serviceWaitMs, "serviceWaitMs", 0, 60000, true);
    if (n !== undefined) config.serviceWaitMs = n;
  }
  if (root.fallbackText !== undefined) {
    const s = c.string(root.fallbackText, "fallbackText", { min: 1, max: 500 });
    if (s !== undefined) config.fallbackText = s;
  }
  if (root.speakChatReplies !== undefined) {
    const b = c.boolean(root.speakChatReplies, "speakChatReplies");
    if (b !== undefined) config.speakChatReplies = b;
  }

  if (root.toolCallLogs !== undefined) {
    if (
      root.toolCallLogs === "full" ||
      root.toolCallLogs === "redacted" ||
      root.toolCallLogs === "off"
    ) {
      config.toolCallLogs = root.toolCallLogs;
    } else {
      c.err("toolCallLogs", 'must be one of "full", "redacted", "off"');
    }
  }

  if (c.errors.length > 0) return { ok: false, errors: c.errors };
  return { ok: true, config: config as LlmAgentConfig, warnings };
}

const envName = {
  type: "string",
  pattern: "^AGENT_[A-Z0-9_]{1,57}$",
  description:
    "Name of an AGENT_* environment variable (project secret), never its value.",
};
const nameList = {
  type: "array",
  items: { type: "string", minLength: 1, maxLength: 128 },
};

export const LLM_AGENT_CONFIG_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://voicethere.io/schema/voicethere.llm.schema.json",
  title: "VoiceThere LLM agent config",
  type: "object",
  additionalProperties: false,
  required: ["version", "provider", "apiKeySecret"],
  properties: {
    $schema: { type: "string" },
    version: { const: 1 },
    provider: { enum: [...PROVIDER_IDS] },
    model: { type: "string", minLength: 1, maxLength: 200 },
    apiKeySecret: envName,
    baseUrl: {
      type: "string",
      format: "uri",
      pattern: "^https?://",
      description: 'Only allowed when provider is "openai".',
    },
    temperature: { type: "number", minimum: 0, maximum: 2 },
    maxOutputTokens: {
      type: "integer",
      minimum: 1,
      maximum: 8192,
      default: 512,
    },
    greeting: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: {
        text: { type: "string", minLength: 1, maxLength: 500 },
        interruptible: { type: "boolean", default: false },
      },
    },
    bargeIn: {
      type: "object",
      additionalProperties: false,
      required: ["mode"],
      properties: { mode: { enum: ["project", "on", "off"] } },
      default: { mode: "project" },
    },
    speechDuringNonInterruptible: {
      enum: ["answer_after", "discard"],
      default: "answer_after",
    },
    history: {
      type: "object",
      additionalProperties: false,
      properties: {
        turns: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        interruptionNote: { type: "boolean", default: true },
      },
    },
    tools: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxRounds: { type: "integer", minimum: 1, maximum: 10, default: 5 },
        timeoutMs: {
          type: "integer",
          minimum: 1000,
          maximum: 60000,
          default: 15000,
        },
        maxResultBytes: {
          type: "integer",
          minimum: 1024,
          maximum: 65536,
          default: 16384,
        },
        filler: {
          type: "object",
          deprecated: true,
          description:
            "Deprecated: use the top-level fillers block. Ignored when fillers is set.",
          additionalProperties: false,
          required: ["text"],
          properties: {
            text: { type: "string", minLength: 1, maxLength: 500 },
            afterMs: {
              type: "integer",
              minimum: 500,
              maximum: 10000,
              default: 1500,
            },
            interruptible: { type: "boolean", default: false },
          },
        },
      },
    },
    fillers: {
      type: "object",
      description:
        "Short sentences the agent speaks while the caller waits. Off when absent. At most 3 fillers per turn, never back to back.",
      additionalProperties: false,
      properties: {
        thinking: {
          type: "object",
          description:
            "Spoken when no sentence of the reply was spoken afterMs after the model call started. At most once per turn.",
          additionalProperties: false,
          properties: {
            phrases: {
              type: "array",
              description:
                "Phrases to pick from at random, never the same as the previous filler of the session. Empty or absent turns this situation off.",
              maxItems: 20,
              items: { type: "string", minLength: 1, maxLength: 60 },
            },
            afterMs: {
              type: "integer",
              description:
                "Wait for the first sentence of the reply, in milliseconds.",
              minimum: 300,
              maximum: 10000,
              default: 1500,
            },
          },
        },
        toolCall: {
          type: "object",
          description:
            "Spoken right when the model requests a tool call, only if nothing was spoken in the turn yet. At most once per turn.",
          additionalProperties: false,
          properties: {
            phrases: {
              type: "array",
              description:
                "Phrases to pick from at random, never the same as the previous filler of the session. Empty or absent turns this situation off.",
              maxItems: 20,
              items: { type: "string", minLength: 1, maxLength: 120 },
            },
          },
        },
        toolWait: {
          type: "object",
          description:
            "Spoken when a tool round is still running afterMs after it started. At most once per tool round, twice per turn.",
          additionalProperties: false,
          properties: {
            phrases: {
              type: "array",
              description:
                "Phrases to pick from at random, never the same as the previous filler of the session. Empty or absent turns this situation off.",
              maxItems: 20,
              items: { type: "string", minLength: 1, maxLength: 120 },
            },
            afterMs: {
              type: "integer",
              description:
                "How long a tool round runs before the filler, in milliseconds.",
              minimum: 1000,
              maximum: 30000,
              default: 4000,
            },
          },
        },
        interruptible: {
          type: "boolean",
          description: "Whether barge-in may cut a filler.",
          default: true,
        },
      },
    },
    speech: {
      type: "object",
      description: "How the reply is spoken.",
      additionalProperties: false,
      properties: {
        coalesceMs: {
          type: "integer",
          description:
            "Sentences that complete within this window are spoken as one utterance, so a reply that arrives at once has no gap between sentences. 0 speaks every sentence on its own.",
          minimum: 0,
          maximum: 1000,
          default: 150,
        },
      },
    },
    toolSources: {
      type: "array",
      maxItems: MAX_SOURCES,
      items: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["kind"],
            properties: {
              kind: { const: "service" },
              path: { type: "string", pattern: "^/", default: "/mcp" },
              allow: nameList,
              deny: nameList,
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "name", "url"],
            properties: {
              kind: { const: "mcp" },
              name: { type: "string", pattern: "^[a-z0-9-]{1,40}$" },
              url: {
                type: "string",
                format: "uri",
                pattern: "^https://",
                description:
                  "https only; local and private addresses are rejected.",
              },
              auth: {
                oneOf: [
                  {
                    type: "object",
                    additionalProperties: false,
                    required: ["type"],
                    properties: { type: { const: "none" } },
                  },
                  {
                    type: "object",
                    additionalProperties: false,
                    required: ["type", "secret"],
                    properties: {
                      type: { const: "bearer" },
                      secret: envName,
                    },
                  },
                  {
                    type: "object",
                    additionalProperties: false,
                    required: ["type", "headers"],
                    properties: {
                      type: { const: "headers" },
                      headers: {
                        type: "object",
                        propertyNames: { pattern: "^[A-Za-z0-9-]{1,64}$" },
                        additionalProperties: envName,
                      },
                    },
                  },
                ],
              },
              allow: nameList,
              deny: nameList,
            },
          },
        ],
      },
    },
    interruptPolicy: { enum: ["cancel", "finish"], default: "cancel" },
    serviceWaitMs: {
      type: "integer",
      minimum: 0,
      maximum: 60000,
      default: 20000,
    },
    fallbackText: {
      type: "string",
      minLength: 1,
      maxLength: 500,
      default: "Sorry, something went wrong. Please try again.",
    },
    speakChatReplies: { type: "boolean", default: true },
    toolCallLogs: {
      enum: ["full", "redacted", "off"],
      default: "redacted",
      description:
        "Agent log line per tool call. redacted removes secret values, sensitive keys and common personal data; full removes only secret values; off writes nothing.",
    },
  },
} as const;
