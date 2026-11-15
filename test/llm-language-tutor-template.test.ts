import { createHash, randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildAgentBundle } from "../src/build-bundle.js";
import { validateLlmAgentConfig } from "../src/llm/agent/config.js";
import { listTemplates } from "../src/templates/index.js";
import {
  createRedisKnowledgeBase,
  searchKnowledgeTool,
  type LlmEmbedder,
} from "../src/llm/index.js";
import { createLlmAgent } from "../src/llm/agent/create-llm-agent.js";
import type {
  KnowledgeBase,
  LlmProvider,
  LlmRequest,
  LlmStreamEvent,
  LlmToolCall,
} from "../src/llm/index.js";
import {
  SESSION_START_INIT_DELAY_ENABLED_ENV,
  defineAgent,
  resetAgentIpcStateForTests,
} from "../src/runtime.js";
import { installProcessMessageCapture } from "./helpers/process-mock.js";
import { writeRequestFixture } from "./helpers/request-fixture.js";
import { openTestRedis } from "./helpers/test-redis.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const templatesDir = join(root, "templates");
const templateDir = join(templatesDir, "llm-language-tutor");

function readConfig() {
  return JSON.parse(
    readFileSync(join(templateDir, "voicethere.llm.json"), "utf8"),
  );
}

describe("llm-language-tutor template", () => {
  it("is a creatable product template and ships every listed file", () => {
    const template = listTemplates({ kind: "product" }).find(
      (t) => t.id === "llm-language-tutor",
    );
    expect(template).toBeDefined();
    expect(template?.seedOnCreate).toBe(true);
    expect(template?.entry).toBe("llm-language-tutor/agent.ts");
    expect(template?.sourceFiles).toContain(
      "llm-language-tutor/knowledge/lessons.md",
    );
    for (const f of template?.sourceFiles ?? []) {
      expect(existsSync(join(templatesDir, f)), f).toBe(true);
    }
  });

  it("prompt requires searching before saying anything", () => {
    const prompt = readFileSync(join(templateDir, "prompt.md"), "utf8");
    expect(prompt).toContain("before you say anything");
  });

  it("config validates with Redis knowledge on and openrouter embeddings", () => {
    const config = readConfig();
    const result = validateLlmAgentConfig(config);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(config.knowledge.store).toBe("redis");
    expect(config.knowledge.embeddings.provider).toBe("openrouter");
    expect(config.knowledge.embeddings.model).toBe(
      "openai/text-embedding-3-small",
    );
    expect(config.knowledge.embeddings.dimensions).toBeUndefined();
    expect(config.knowledge.redis.namespace).toBe("tutor");
  });

  it("bundles with the prompt, greeting and lessons", async () => {
    const dir = mkdtempSync(join(tmpdir(), "voicethere-tutor-bundle-"));
    const outfile = join(dir, "agent.js");
    try {
      await buildAgentBundle({
        cwd: root,
        entry: "templates/llm-language-tutor/agent.ts",
        outfile,
      });
      const source = readFileSync(outfile, "utf8");
      expect(source).toContain("I'm your English practice partner");
      expect(source).toContain("English conversation tutor");
      expect(source).toContain("Break the ice");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

const harness = await openTestRedis();
let queryEngine = false;
if (harness) {
  try {
    await harness.redis.call("FT._LIST");
    queryEngine = true;
  } catch {
    queryEngine = false;
  }
}
// The Query Engine only creates indexes in db 0.
const kbUrl = harness ? new URL("/0", harness.url).toString() : "";

describe.skipIf(!queryEngine)(
  "llm-language-tutor template knowledge (real Redis 8)",
  () => {
    it("search_knowledge for 'break the ice' returns the small talk lesson", async () => {
      const lessons = readFileSync(
        join(templateDir, "knowledge", "lessons.md"),
        "utf8",
      );
      const dims = 512;
      const embedder: LlmEmbedder = {
        id: "openrouter",
        async embed(req) {
          const d = req.dimensions ?? dims;
          const vectors = req.inputs.map((text) => {
            const v = new Array<number>(d).fill(0);
            for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
              const h = createHash("sha1").update(w).digest().readUInt32BE(0);
              v[h % d]! += 1;
            }
            const norm = Math.hypot(...v) || 1;
            return v.map((x) => x / norm);
          });
          return { vectors, model: "fake", dims: d };
        },
      };
      const namespace = `tpl${randomUUID().replaceAll("-", "")}`;
      const base = createRedisKnowledgeBase({
        redisUrl: kbUrl,
        namespace,
        documents: [{ id: "lessons", title: "Lessons", text: lessons }],
        embedder,
        model: "fake",
        dims,
        limits: { pollMs: 10 },
      });
      const cleaner = new Redis(kbUrl, { maxRetriesPerRequest: 1 });
      try {
        expect((await base.ensureIndexed()).chunks).toBeGreaterThan(1);
        const tool = searchKnowledgeTool(base, {
          topK: readConfig().knowledge.topK,
        });
        const out = await tool.handler(
          { query: "what does break the ice mean" },
          { signal: new AbortController().signal } as never,
        );
        expect(out).toContain("Small talk at work");
        expect(out).toContain(
          "start a conversation with people who don't know",
        );
      } finally {
        await base.close();
        const names = (await cleaner.call("FT._LIST")) as string[];
        for (const n of names.filter((x) => x.startsWith(`kb:${namespace}:`))) {
          await cleaner.call("FT.DROPINDEX", n, "DD");
        }
        const keys = await cleaner.keys(`kb:${namespace}:*`);
        if (keys.length > 0) await cleaner.del(...keys);
        cleaner.disconnect();
        await harness?.close();
      }
    }, 30_000);
  },
);

// --- Promise probes -------------------------------------------------------
// Each promise the README / prompt.md makes about model behaviour is tied to a
// named instruction in the system prompt, and the request the runtime sends in
// each concurrency shape is captured with WRITE_INCIDENT_FIXTURE=<dir> for the
// e2e probe (rule template-promise-probed-at-shipped-model).

type Msg = Record<string, unknown>;
type Shape = "settled" | "in-flight" | "interrupted" | "after-tool-chat";

const TUTOR_PROMPT = readFileSync(join(templateDir, "prompt.md"), "utf8");
const TUTOR_PROMPT_SHA = createHash("sha256")
  .update(TUTOR_PROMPT)
  .digest("hex");
const TUTOR_INSTRUCTIONS = {
  T1: "call search_knowledge first",
  T1b: "before you say anything",
  T2: "Speak English only",
  T3: "Never make up the meaning of an idiom",
} as const;

/** One `##` lesson chunk of the template's own lessons. */
function lessonChunk(heading: string): string {
  const lessons = readFileSync(
    join(templateDir, "knowledge", "lessons.md"),
    "utf8",
  );
  const start = lessons.indexOf(`## ${heading}`);
  const next = lessons.indexOf("\n## ", start + 1);
  return lessons.slice(start, next === -1 ? undefined : next).trim();
}

const fakeKnowledge: KnowledgeBase = {
  async ensureIndexed() {
    return { status: "fresh", chunks: 1, waitedMs: 0, contentHash: "fake" };
  },
  async gc() {
    return [];
  },
  async search(query) {
    const lesson = /break the ice/i.test(query)
      ? "Small talk at work"
      : /hit the ground running/i.test(query)
        ? "A job interview"
        : undefined;
    return lesson
      ? [
          {
            title: lesson,
            source: "lessons",
            score: 0.9,
            text: lessonChunk(lesson),
          },
        ]
      : [];
  },
  async close() {},
};

function expectTutorInstructions(req: LlmRequest): void {
  expect(req.tools.map((t) => t.name)).toContain("search_knowledge");
  for (const sentence of Object.values(TUTOR_INSTRUCTIONS)) {
    expect(req.system).toContain(sentence);
  }
}

function lastUserTextOf(req: LlmRequest): string {
  const users = req.messages.filter((m) => m.role === "user");
  return (users[users.length - 1] as { text: string }).text;
}

describe("llm-language-tutor promises", () => {
  let capture: ReturnType<typeof installProcessMessageCapture>;
  const requests: LlmRequest[] = [];
  type Step = { text?: string; toolCalls?: LlmToolCall[] };
  const script: Step[] = [];

  const provider: LlmProvider = {
    id: "openai",
    stream(req) {
      requests.push(structuredClone({ ...req, signal: undefined }));
      const step = script.shift() ?? { text: "Okay." };
      const text = step.text ?? "";
      const toolCalls = step.toolCalls ?? [];
      return (async function* (): AsyncIterable<LlmStreamEvent> {
        if (text) yield { type: "text_delta", text };
        yield {
          type: "done",
          stopReason: toolCalls.length > 0 ? "tool_calls" : "end",
          text,
          toolCalls,
        };
      })();
    },
  };

  beforeEach(() => {
    resetAgentIpcStateForTests();
    process.env[SESSION_START_INIT_DELAY_ENABLED_ENV] = "false";
    process.env.__CHILD_BUNDLE_PATH__ = "/tmp/agent.js";
    capture = installProcessMessageCapture();
    requests.length = 0;
    script.length = 0;
  });

  afterEach(() => {
    capture.emit({ type: "session_end", sessionId: "s1" });
    capture.restore();
    resetAgentIpcStateForTests();
    delete process.env[SESSION_START_INIT_DELAY_ENABLED_ENV];
    delete process.env.__CHILD_BUNDLE_PATH__;
  });

  const sent = (type: string): Msg[] =>
    capture.send.mock.calls
      .map((c) => c[0] as Msg)
      .filter((m) => m.type === type);
  const say = (text: string) =>
    capture.emit({
      type: "speech_event",
      sessionId: "s1",
      event: { type: "user_speech_final", text },
    });
  const chat = (text: string) =>
    capture.emit({
      type: "data_channel_message",
      sessionId: "s1",
      payload: JSON.stringify({ type: "chat", text }),
    });
  const speakResults = (turnId: unknown, status: string, playedMs: number) => {
    for (const m of sent("speak").filter((x) => x.turnId === turnId)) {
      capture.emit({
        type: "speak_result",
        sessionId: "s1",
        requestId: m.requestId,
        turnId,
        status,
        playedMs,
      });
    }
  };
  const interrupt = (turnId: unknown, played: string, unplayed: string) => {
    capture.emit({
      type: "agent_interrupted",
      sessionId: "s1",
      turnId,
      replyPlayedMs: 1200,
      playedText: played,
      unplayedText: unplayed,
      playedTextExact: true,
      cancelledRequestIds: [],
    });
    speakResults(turnId, "interrupted", 1200);
  };

  async function boot(systemPrompt = TUTOR_PROMPT): Promise<unknown> {
    defineAgent(
      createLlmAgent({
        config: {
          ...readConfig(),
          provider: "openai",
          apiKeySecret: "AGENT_TEST_KEY",
          speech: { coalesceMs: 0 },
          knowledge: {
            ...readConfig().knowledge,
            embeddings: {
              ...readConfig().knowledge.embeddings,
              apiKeySecret: "AGENT_TEST_KEY",
            },
          },
        },
        systemPrompt,
        provider,
        knowledge: { base: fakeKnowledge },
        env: () => ({ AGENT_TEST_KEY: "secret-value" }),
      }),
    );
    capture.emit({
      type: "session_start",
      sessionId: "s1",
      env: {},
      speakControlAvailable: true,
    });
    await vi.waitFor(() => expect(sent("session_start_ack")).toHaveLength(1));
    await vi.waitFor(() => expect(sent("speak")).toHaveLength(1));
    return sent("speak")[0]!.turnId;
  }

  const lastRequest = () => requests[requests.length - 1]!;

  /**
   * Drives the harness into `shape` and returns the request the model would
   * answer for `userText`. A first exchange ("Hello") precedes every shape.
   */
  async function drive(
    shape: Shape,
    userText: string,
    systemPrompt = TUTOR_PROMPT,
  ): Promise<LlmRequest> {
    const greetTurn = await boot(systemPrompt);
    speakResults(greetTurn, "played", 3000);
    script.push({ text: "Nice to meet you. How are you today?" });
    say("Hello");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await vi.waitFor(() =>
      expect(
        sent("speak").filter((m) => m.turnId !== greetTurn).length,
      ).toBeGreaterThan(0),
    );
    const replyTurn = sent("speak").find((m) => m.turnId !== greetTurn)!.turnId;
    const before = requests.length;
    if (shape === "settled") {
      speakResults(replyTurn, "played", 3000);
      script.push({ text: "Okay." });
      say(userText);
    } else if (shape === "in-flight") {
      script.push({ text: "Okay." });
      chat(userText);
    } else if (shape === "interrupted") {
      interrupt(replyTurn, "Nice to meet you.", "How are you today?");
      script.push({ text: "Okay." });
      say(userText);
    } else {
      // after-tool-chat: a tool round whose answer is still unplayed, then chat.
      script.push(
        {
          toolCalls: [
            {
              id: "c1",
              name: "search_knowledge",
              input: { query: "break the ice" },
            },
          ],
        },
        { text: "It means to start a conversation." },
      );
      say("What does break the ice mean?");
      await vi.waitFor(() => expect(requests).toHaveLength(before + 2));
      script.push({ text: "Okay." });
      chat(userText);
      await vi.waitFor(() => expect(requests).toHaveLength(before + 3));
      return lastRequest();
    }
    await vi.waitFor(() => expect(requests).toHaveLength(before + 1));
    return lastRequest();
  }

  const meta = (promise: string, shape: string) => ({
    template: "llm-language-tutor",
    promise,
    shape,
    promptSha256: TUTOR_PROMPT_SHA,
  });

  const SHAPES: Shape[] = [
    "settled",
    "in-flight",
    "interrupted",
    "after-tool-chat",
  ];

  describe("T1: a phrase or idiom question calls search_knowledge before any reply", () => {
    it.each(SHAPES)("shape %s", async (shape) => {
      // after-tool-chat asks a different idiom than its first turn, so a
      // correct model cannot answer from history without a new search.
      const question =
        shape === "after-tool-chat"
          ? "What does hit the ground running mean?"
          : "What does break the ice mean?";
      const req = await drive(shape, question);
      expectTutorInstructions(req);
      expect(req.toolChoice).toBeUndefined();
      expect(lastUserTextOf(req)).toContain(question);
      if (shape === "in-flight" || shape === "after-tool-chat") {
        expect(req.messages[0]).toMatchObject({
          role: "user",
          text: "(The call has started.)",
        });
        expect(req.messages[1]).toMatchObject({ role: "assistant" });
      }
      writeRequestFixture("T1", req, meta("T1", shape));
    });
  });

  describe("T2: English only, even when the learner switches language", () => {
    it.each(SHAPES.filter((s) => s !== "after-tool-chat"))(
      "shape %s",
      async (shape) => {
        const req = await drive(shape, "¿Puedes hablar español conmigo?");
        expectTutorInstructions(req);
        expect(lastUserTextOf(req)).toContain("hablar español");
        if (shape === "in-flight") {
          expect(req.messages[0]).toMatchObject({
            role: "user",
            text: "(The call has started.)",
          });
          expect(req.messages[1]).toMatchObject({ role: "assistant" });
        }
        writeRequestFixture("T2", req, meta("T2", shape));
      },
    );
  });

  describe("T3: an idiom is answered from the search result only", () => {
    it.each([
      ["found", "break the ice", "Break the ice"],
      ["empty", "piece of cake on a stick", "No matching knowledge found."],
    ])("search result %s", async (label, query, expected) => {
      await boot();
      script.push(
        {
          toolCalls: [{ id: "c1", name: "search_knowledge", input: { query } }],
        },
        { text: "Okay." },
      );
      say(`What does ${query} mean?`);
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      const req = lastRequest();
      expectTutorInstructions(req);
      const last = req.messages[req.messages.length - 1]!;
      expect(last.role).toBe("tool");
      expect(JSON.stringify(last)).toContain(expected);
      writeRequestFixture("T3", req, meta("T3", label));
    });
  });

  describe("instruction removal fails the matching assertion", () => {
    it.each([
      ["T1", TUTOR_INSTRUCTIONS.T1],
      ["T2", TUTOR_INSTRUCTIONS.T2],
      ["T3", TUTOR_INSTRUCTIONS.T3],
    ])("%s: removing %j", async (_id, sentence) => {
      expect(TUTOR_PROMPT).toContain(sentence);
      const req = await drive(
        "settled",
        "What does break the ice mean?",
        TUTOR_PROMPT.replace(sentence, ""),
      );
      expect(() => expectTutorInstructions(req)).toThrow(sentence);
    });
  });
});
