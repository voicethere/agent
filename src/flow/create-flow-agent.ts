import { agentLog, parseChatText } from "../runtime.js";
import type { AgentHandlers, SessionContext } from "../runtime.js";
import { LLM_AGENT_CONFIG_DEFAULTS } from "../llm/agent/config.js";
import { buildToolRegistry } from "../llm/agent/build-tool-registry.js";
import { createLlmProvider } from "../llm/providers.js";
import type { McpToolSource } from "../llm/mcp/mcp-tool-source.js";
import type { McpToolSourceOptions } from "../llm/mcp/mcp-tool-source.js";
import type { CustomTool, ToolRegistry } from "../llm/mcp/tool-registry.js";
import type { LlmProvider, LlmProviderModule } from "../llm/types.js";
import { compileFlow } from "./core/compile.js";
import type { FlowEffects } from "./core/effects.js";
import { FlowSession } from "./core/interpreter.js";
import { migrateFlow } from "./core/migrate.js";
import { createMockEffects } from "./core/mock-effects.js";
import { validateMocks } from "./core/mocks.js";
import type { FlowMocks } from "./core/mocks.js";
import type { FlowModel } from "./core/types.js";
import { validateFlow } from "./core/validate.js";
import { createNodeEffects } from "./effects-node.js";
import type { NodeEffectsOptions } from "./effects-node.js";

const D = LLM_AGENT_CONFIG_DEFAULTS;

export interface CreateFlowAgentOptions {
  /** The parsed `voicethere.flow.json`. Migrated, validated and compiled here. */
  flow: unknown;
  /** Custom tools (`defineTool`) that `llm` nodes may offer. */
  tools?: CustomTool[];
  /** Provider SDK modules, e.g. `[openai]` from `@voicethere/agent/llm/openai`. */
  providers?: readonly LlmProviderModule[];
  /** Environment used to resolve secrets. Default `process.env`. */
  env?: () => Record<string, string | undefined>;
  /** Test injection for MCP tool sources. */
  sourceFactory?: (opts: McpToolSourceOptions) => McpToolSource;
  /** Test injection: replaces the runtime-backed effects. */
  effectsFactory?: (opts: NodeEffectsOptions) => FlowEffects;
  /** Test injection: one provider for every model. */
  provider?: LlmProvider;
  /**
   * Local and test use only: answers http / mcp / llm / route from mock cases
   * (parsed `voicethere.flow.mocks.json`). No keys or network are needed. The
   * template's `agent.ts` never passes it.
   */
  mocks?: unknown;
}

function flowError(message: string, code: string): Error {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

function codeOf(err: unknown): string {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === "string" && c !== "" ? c : "FLOW_TASK_ERROR";
}

/**
 * Builds the agent handlers for a flow. Handlers only post to the session's
 * task and return (`rt.serial-queue-head-of-line`): they never await a speak,
 * an HTTP call or an LLM round.
 */
export function createFlowAgent(opts: CreateFlowAgentOptions): AgentHandlers {
  const migrated = migrateFlow(opts.flow);
  const validated = validateFlow(migrated.doc);
  if (!validated.ok || !validated.flow) {
    const first = validated.errors
      .slice(0, 5)
      .map((e) => `${e.code} ${e.path}: ${e.message}`)
      .join("\n");
    throw flowError(`invalid flow:\n${first}`, "FLOW_INVALID");
  }
  const flow = validated.flow;
  const compiled = compileFlow(flow);

  let mocks: FlowMocks | undefined;
  if (opts.mocks !== undefined) {
    const mv = validateMocks(opts.mocks, flow);
    if (!mv.ok || !mv.mocks) {
      const first = mv.errors
        .slice(0, 5)
        .map((e) => `${e.code} ${e.path}: ${e.message}`)
        .join("\n");
      throw flowError(`invalid mocks:\n${first}`, "FLOW_MOCKS_INVALID");
    }
    mocks = mv.mocks;
  }

  if (!opts.provider && !mocks) {
    for (const [name, m] of Object.entries(compiled.models)) {
      if (!(opts.providers ?? []).some((mod) => mod.ids.includes(m.provider))) {
        const sub = m.provider === "openrouter" ? "openai" : m.provider;
        const q = '"';
        throw flowError(
          `voicethere.flow.json model ${q}${name}${q} selects provider ${q}${m.provider}${q}, but agent.ts does not register it. Add: import { ${sub} } from ${q}@voicethere/agent/llm/${sub}${q}; and pass providers: [${sub}]`,
          "FLOW_INVALID",
        );
      }
    }
  }

  const getEnv = opts.env ?? (() => process.env);
  const providerCache = new Map<string, LlmProvider>();
  let registry: ToolRegistry | undefined;
  let serviceSource: McpToolSource | undefined;
  let serviceWaited = false;
  const sessions = new Map<string, FlowSession>();

  function providerFor(model: FlowModel): LlmProvider {
    if (opts.provider) return opts.provider;
    const key = `${model.provider}\u0000${model.baseUrl ?? ""}\u0000${model.apiKeySecret}`;
    const hit = providerCache.get(key);
    if (hit) return hit;
    const apiKey = getEnv()[model.apiKeySecret];
    if (apiKey === undefined || apiKey === "")
      throw flowError(
        `environment variable ${model.apiKeySecret} is not set`,
        "LLM_API_KEY_MISSING",
      );
    const p = createLlmProvider(
      {
        provider: model.provider,
        apiKey,
        ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
      },
      opts.providers ?? [],
    );
    providerCache.set(key, p);
    return p;
  }

  async function beforeTools(): Promise<void> {
    if (serviceWaited || !serviceSource) return;
    serviceWaited = true;
    if (serviceSource.status === "ready") return;
    await serviceSource.ready(D.serviceWaitMs);
  }

  function fire(sessionId: string, work: Promise<void>): void {
    work.catch((err: unknown) => {
      // Code only: an error message can carry customer content.
      agentLog("error", "flow task failed", { code: codeOf(err) }, sessionId);
    });
  }

  return {
    onAgentStart() {
      if (!opts.provider && !opts.effectsFactory && !mocks) {
        // Fail the deploy load check early, not on the first caller turn.
        const env = getEnv();
        for (const m of Object.values(compiled.models)) {
          const v = env[m.apiKeySecret];
          if (v === undefined || v === "")
            throw flowError(
              `environment variable ${m.apiKeySecret} is not set`,
              "LLM_API_KEY_MISSING",
            );
        }
      }
      // Mock mode never starts tool sources (no network).
      if (mocks) return;
      const toolSources = flow.tools?.toolSources ?? [];
      const customTools = opts.tools ?? [];
      if (toolSources.length === 0 && customTools.length === 0) return;
      const built = buildToolRegistry({
        env: getEnv(),
        toolSources,
        customTools,
        secretNames: [
          "AGENT_SERVICE_TOKEN",
          ...Object.values(compiled.models).map((m) => m.apiKeySecret),
        ],
        toolCallLogs: D.toolCallLogs,
        servicePath: D.servicePath,
        makeSource: opts.sourceFactory,
      });
      registry = built.registry;
      serviceSource = built.serviceSource;
    },

    onSessionStart(ctx: SessionContext) {
      const sessionId = ctx.sessionId;
      const baseEffects = (opts.effectsFactory ?? createNodeEffects)({
        sessionId,
        env: getEnv(),
        providerFor,
        registry,
        beforeTools,
      });
      const effects = mocks
        ? createMockEffects(baseEffects, mocks)
        : baseEffects;
      const session = new FlowSession(compiled, effects, {
        sessionId,
        channel: "voice",
      });
      sessions.set(sessionId, session);
      fire(sessionId, session.start());
    },

    onUserSpeechFinal(ctx) {
      const s = sessions.get(ctx.sessionId);
      const text = ctx.text.trim();
      if (!s || !text) return;
      fire(
        ctx.sessionId,
        s.onUserText(text, {
          source: "voice",
          ...(ctx.utteranceId !== undefined
            ? { utteranceId: ctx.utteranceId }
            : {}),
        }),
      );
    },

    onDataChannelMessage(ctx) {
      const text = parseChatText(ctx.message);
      const s = sessions.get(ctx.sessionId);
      if (!s || !text) return;
      fire(ctx.sessionId, s.onUserText(text, { source: "chat" }));
    },

    onSessionEnd(ctx) {
      sessions.get(ctx.sessionId)?.stop();
      sessions.delete(ctx.sessionId);
    },
  };
}
