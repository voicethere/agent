import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLlmAgent } from "../../src/llm/agent/create-llm-agent.js";
import { secretValuesFromEnv } from "../../src/llm/agent/redact.js";
import { openai } from "../../src/llm/openai.js";
import type {
  KnowledgeBase,
  KnowledgeHit,
} from "../../src/llm/knowledge/index.js";
import type {
  LlmProvider,
  LlmRequest,
  LlmStreamEvent,
} from "../../src/llm/types.js";
import {
  SESSION_START_INIT_DELAY_ENABLED_ENV,
  defineAgent,
  resetAgentIpcStateForTests,
} from "../../src/runtime.js";
import { installProcessMessageCapture } from "../helpers/process-mock.js";

type Msg = Record<string, unknown>;
const SESSION = "peer-1";

const BASE = {
  version: 1,
  provider: "openai",
  apiKeySecret: "AGENT_TEST_KEY",
  speech: { coalesceMs: 0 },
};

function scripted(): { provider: LlmProvider; requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  let n = 0;
  const provider: LlmProvider = {
    id: "openai",
    stream(req) {
      requests.push(structuredClone({ ...req, signal: undefined }));
      const first = n === 0 && req.tools.length > 0;
      n += 1;
      const events: LlmStreamEvent[] = first
        ? [
            {
              type: "done",
              stopReason: "tool_calls",
              text: "",
              toolCalls: [
                {
                  id: "c1",
                  name: "search_knowledge",
                  input: { query: "price" },
                },
              ],
              usage: { inputTokens: 1, outputTokens: 1 },
            },
          ]
        : [
            { type: "text_delta", text: "Ten dollars." },
            {
              type: "done",
              stopReason: "end",
              text: "Ten dollars.",
              toolCalls: [],
              usage: { inputTokens: 1, outputTokens: 1 },
            },
          ];
      return (async function* () {
        for (const e of events) yield e;
      })();
    },
  };
  return { provider, requests };
}

function fakeKb(hits: KnowledgeHit[]): KnowledgeBase {
  return {
    ensureIndexed: async () => ({
      status: "fresh",
      chunks: 1,
      waitedMs: 0,
      contentHash: "h",
    }),
    gc: async () => [],
    search: async () => hits,
    close: async () => undefined,
  };
}

describe("createLlmAgent knowledge", () => {
  let capture: ReturnType<typeof installProcessMessageCapture>;

  beforeEach(() => {
    resetAgentIpcStateForTests();
    process.env[SESSION_START_INIT_DELAY_ENABLED_ENV] = "false";
    process.env.__CHILD_BUNDLE_PATH__ = "/tmp/agent.js";
    capture = installProcessMessageCapture();
  });
  afterEach(() => {
    capture.emit({ type: "session_end", sessionId: SESSION });
    capture.restore();
    resetAgentIpcStateForTests();
    delete process.env[SESSION_START_INIT_DELAY_ENABLED_ENV];
    delete process.env.__CHILD_BUNDLE_PATH__;
  });

  const sent = (type: string): Msg[] =>
    capture.send.mock.calls
      .map((c) => c[0] as Msg)
      .filter((m) => m.type === type);

  async function boot(
    over: {
      config?: Record<string, unknown>;
      env?: Record<string, string>;
      knowledge?: { base?: KnowledgeBase };
      providers?: boolean;
    } = {},
  ) {
    const fake = scripted();
    const handlers = createLlmAgent({
      config: { ...BASE, ...over.config },
      systemPrompt: "test",
      provider: fake.provider,
      providers: over.providers ? [openai] : undefined,
      env: () => ({ AGENT_TEST_KEY: "secret-value", ...over.env }),
      knowledge: over.knowledge,
    });
    defineAgent(handlers);
    capture.emit({
      type: "session_start",
      sessionId: SESSION,
      env: { SESSION_ID: SESSION },
      speakControlAvailable: true,
    });
    await vi.waitFor(() => expect(sent("session_start_ack")).toHaveLength(1));
    return fake;
  }

  const say = (text: string) =>
    capture.emit({
      type: "speech_event",
      sessionId: SESSION,
      event: { type: "user_speech_final", text },
    });

  it("an injected base registers search_knowledge and a call returns hit text", async () => {
    const { requests } = await boot({
      config: {
        knowledge: { store: "redis", embeddings: { provider: "openai" } },
      },
      knowledge: {
        base: fakeKb([
          {
            text: "The starter plan costs ten dollars.",
            title: "Billing",
            source: "billing.md",
            score: 0.9,
          },
        ]),
      },
    });
    say("how much?");
    await vi.waitFor(() => expect(sent("speak")).toHaveLength(1));
    expect(requests[0]!.tools.map((t) => t.name)).toEqual(["search_knowledge"]);
    const last = requests[1]!.messages.at(-1) as unknown as {
      results: Array<{ content: string; isError: boolean }>;
    };
    expect(last.results[0]!.isError).toBe(false);
    expect(last.results[0]!.content).toContain(
      "The starter plan costs ten dollars.",
    );
  });

  it("store redis without AGENT_REDIS_URL: no tool and one log line", async () => {
    const { requests } = await boot({
      config: {
        knowledge: { store: "redis", embeddings: { provider: "openai" } },
      },
      providers: true,
      knowledge: {},
    });
    say("hi");
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(requests[0]!.tools).toEqual([]);
    const lines = sent("log").filter((m) =>
      String(m.message).includes("AGENT_REDIS_URL unset"),
    );
    expect(lines).toHaveLength(1);
  });

  it("store redis with Redis but no documents: no tool", async () => {
    const { requests } = await boot({
      config: {
        knowledge: { store: "redis", embeddings: { provider: "openai" } },
      },
      providers: true,
      env: { AGENT_REDIS_URL: "redis://127.0.0.1:1/0" },
      knowledge: {},
    });
    say("hi");
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(requests[0]!.tools).toEqual([]);
  });

  it("a non-https supabase url does not fail start: one log line, no tool, no url in the log", async () => {
    const { requests } = await boot({
      config: {
        knowledge: {
          store: "supabase",
          embeddings: { provider: "openai" },
          supabase: {
            urlSecret: "AGENT_SUPABASE_URL",
            keySecret: "AGENT_SUPABASE_KEY",
          },
        },
      },
      providers: true,
      env: {
        AGENT_SUPABASE_URL: "http://db.example-sentinel.com",
        AGENT_SUPABASE_KEY: "sb-key",
      },
      knowledge: {},
    });
    say("hi");
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(requests[0]!.tools).toEqual([]);
    const lines = sent("log").filter((m) =>
      String(m.message).includes("supabase url must use https"),
    );
    expect(lines).toHaveLength(1);
    expect(JSON.stringify(sent("log"))).not.toContain("example-sentinel");
  });

  it("a missing embeddings provider module is a config error at creation", () => {
    expect(() =>
      createLlmAgent({
        config: {
          ...BASE,
          knowledge: { store: "redis", embeddings: { provider: "openai" } },
        },
        systemPrompt: "t",
        provider: scripted().provider,
      }),
    ).toThrow(/knowledge\.embeddings selects provider "openai"/);
  });

  it("secretValuesFromEnv covers the Supabase and embeddings keys", () => {
    const values = secretValuesFromEnv(
      {
        AGENT_SUPABASE_KEY: "sb-key-1",
        AGENT_SUPABASE_URL: "https://x.supabase.co",
        AGENT_EMB_KEY: "emb-key-1",
      },
      ["AGENT_SUPABASE_KEY", "AGENT_SUPABASE_URL", "AGENT_EMB_KEY"],
    );
    expect(values).toEqual(
      expect.arrayContaining([
        "sb-key-1",
        "https://x.supabase.co",
        "emb-key-1",
      ]),
    );
  });
});
