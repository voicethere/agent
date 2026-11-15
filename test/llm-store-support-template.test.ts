import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildAgentBundle } from "../src/build-bundle.js";
import { validateLlmAgentConfig } from "../src/llm/agent/config.js";
import { getTemplate, listTemplates } from "../src/templates/index.js";
import {
  SAMPLE_PRODUCTS,
  startMcpExample,
  type McpExampleHandle,
} from "../services/mcp-example/server.js";
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
import { assertProviderOrder } from "./llm/agent/provider-order.js";
import { installProcessMessageCapture } from "./helpers/process-mock.js";
import { writeRequestFixture } from "./helpers/request-fixture.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const templatesDir = join(root, "templates");
const templateDir = join(templatesDir, "llm-store-support");
const read = (f: string) => readFileSync(join(templateDir, f), "utf8");
const knowledgeFiles = () =>
  readdirSync(join(templateDir, "knowledge")).filter((f) => f.endsWith(".md"));

describe("llm-store-support template", () => {
  it("is a creatable product template and ships every listed file", () => {
    const template = listTemplates({ kind: "product" }).find(
      (t) => t.id === "llm-store-support",
    );
    expect(template).toBeDefined();
    expect(template?.seedOnCreate).toBe(true);
    expect(template?.entry).toBe("llm-store-support/agent.ts");
    for (const f of getTemplate("llm-store-support").sourceFiles) {
      expect(existsSync(join(templatesDir, f)), f).toBe(true);
    }
  });

  it("lists every knowledge file in sourceFiles and agent.ts", () => {
    const files = knowledgeFiles();
    expect(files.sort()).toEqual([
      "products.md",
      "returns.md",
      "shipping.md",
      "sizing.md",
      "store.md",
      "warranty.md",
    ]);
    const sources = getTemplate("llm-store-support").sourceFiles;
    const agent = read("agent.ts");
    for (const f of files) {
      expect(sources).toContain(`llm-store-support/knowledge/${f}`);
      expect(agent).toContain(`./knowledge/${f}`);
    }
  });

  it("config validates with Redis knowledge, the two price tools and a forced first tool call", () => {
    const config = JSON.parse(read("voicethere.llm.json"));
    const result = validateLlmAgentConfig(config);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(config.model).toBe("amazon/nova-micro-v1");
    expect(config.toolChoice).toBe("required-first-round");
    expect(config.toolSources).toEqual([
      {
        kind: "service",
        path: "/mcp",
        allow: ["list_products", "get_product_price"],
      },
    ]);
    expect(config.knowledge.store).toBe("redis");
    expect(config.knowledge.embeddings.provider).toBe("openrouter");
    expect(config.knowledge.redis.namespace).toBe("store-support");
  });

  it("knowledge files hold no prices and no product price from the catalog", () => {
    for (const f of knowledgeFiles()) {
      const text = readFileSync(join(templateDir, "knowledge", f), "utf8");
      expect(text, f).not.toMatch(/\$\s?\d/);
      expect(text.toLowerCase(), f).not.toMatch(/\bdollars?\b/);
      expect(text, f).not.toMatch(/\bUSD\b/);
      for (const row of Object.values(SAMPLE_PRODUCTS)) {
        expect(text, f).not.toMatch(
          new RegExp(`\\b${row.priceUsd}\\b\\s*(usd|dollars)`, "i"),
        );
      }
    }
  });

  it("knowledge names every catalog product", () => {
    const products = read("knowledge/products.md");
    for (const row of Object.values(SAMPLE_PRODUCTS)) {
      const shortName = row.name.split(" ").slice(0, 2).join(" ");
      expect(products, row.name).toContain(shortName);
    }
  });

  it("prompt searches first, gets prices from the tool and never guesses", () => {
    const prompt = read("prompt.md");
    expect(prompt).toContain("search_knowledge");
    expect(prompt).toContain("get_product_price");
    expect(prompt).toContain("list_products");
    expect(prompt).toContain(
      "Never state a price that did not come from get_product_price",
    );
    expect(prompt).toContain("one to three short sentences");
  });

  it("README names the image, the tools and the health check", () => {
    const readme = read("README.md");
    for (const s of [
      "ghcr.io/voicethere/mcp-example-service",
      "get_product_price",
      "list_products",
      "/healthz",
      "8080",
    ]) {
      expect(readme).toContain(s);
    }
  });

  it("bundles with the prompt, greeting and knowledge", async () => {
    const dir = mkdtempSync(join(tmpdir(), "voicethere-store-bundle-"));
    const outfile = join(dir, "agent.js");
    try {
      await buildAgentBundle({
        cwd: root,
        entry: "templates/llm-store-support/agent.ts",
        outfile,
      });
      const source = readFileSync(outfile, "utf8");
      expect(source).toContain("Kestrel Outdoor support");
      expect(source).toContain("phone support assistant for Kestrel Outdoor");
      expect(source).toContain("Returns and exchanges");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

// --- Promise probes -------------------------------------------------------
// Each promise the README / prompt.md makes about model behaviour is tied to a
// named instruction in the system prompt, and the request the runtime sends in
// each concurrency shape is captured with WRITE_INCIDENT_FIXTURE=<dir> for the
// e2e probe (rule template-promise-probed-at-shipped-model).

type Msg = Record<string, unknown>;
type Shape = "settled" | "in-flight" | "interrupted";

const STORE_PROMPT = read("prompt.md");
const STORE_PROMPT_SHA = createHash("sha256")
  .update(STORE_PROMPT)
  .digest("hex");
const STORE_INSTRUCTIONS = {
  S1: "call get_product_price",
  S2: "Never state a price that did not come from get_product_price",
} as const;
const SEARCH_INSTRUCTION = "Search before you answer such a question";
const SERVICE_TOKEN = "store-probe-token";

/** One `##` chunk of the template's own knowledge file. */
function knowledgeChunk(file: string, heading: string): string {
  const text = read(`knowledge/${file}`);
  const start = text.indexOf(`## ${heading}`);
  const next = text.indexOf("\n## ", start + 1);
  return text.slice(start, next === -1 ? undefined : next).trim();
}

const fakeKnowledge: KnowledgeBase = {
  async ensureIndexed() {
    return { status: "fresh", chunks: 1, waitedMs: 0, contentHash: "fake" };
  },
  async gc() {
    return [];
  },
  async search(query) {
    if (/shipping|deliver/i.test(query)) {
      return [
        {
          title: "Delivery times and carriers",
          source: "shipping",
          score: 0.9,
          text: knowledgeChunk("shipping.md", "Delivery times and carriers"),
        },
      ];
    }
    return [];
  },
  async close() {},
};

function expectStoreInstructions(req: LlmRequest): void {
  expect(req.tools.map((t) => t.name).sort()).toEqual([
    "get_product_price",
    "list_products",
    "search_knowledge",
  ]);
  for (const sentence of Object.values(STORE_INSTRUCTIONS)) {
    expect(req.system, sentence).toContain(sentence);
  }
}

const lastMessage = (req: LlmRequest) => req.messages[req.messages.length - 1]!;
const textOf = (m: unknown) => (m as { text?: string }).text ?? "";

describe("llm-store-support promises", () => {
  let capture: ReturnType<typeof installProcessMessageCapture>;
  let service: McpExampleHandle;
  const requests: LlmRequest[] = [];
  type Step = { text?: string; toolCalls?: LlmToolCall[] };
  const script: Step[] = [];
  let turns = 0;

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

  beforeEach(async () => {
    resetAgentIpcStateForTests();
    process.env[SESSION_START_INIT_DELAY_ENABLED_ENV] = "false";
    process.env.__CHILD_BUNDLE_PATH__ = "/tmp/agent.js";
    capture = installProcessMessageCapture();
    requests.length = 0;
    script.length = 0;
    turns = 0;
    service = await startMcpExample({
      port: 0,
      host: "127.0.0.1",
      token: SERVICE_TOKEN,
    });
  });

  afterEach(async () => {
    capture.emit({ type: "session_end", sessionId: "s1" });
    // Every turn logs once when it ends; wait for the last one before the
    // process mock is removed, or a late log reaches vitest's own channel.
    await vi.waitFor(() =>
      expect(sent("log").filter((m) => m.message === "llm turn")).toHaveLength(
        turns,
      ),
    );
    capture.restore();
    resetAgentIpcStateForTests();
    delete process.env[SESSION_START_INIT_DELAY_ENABLED_ENV];
    delete process.env.__CHILD_BUNDLE_PATH__;
    await service.stop();
  });

  const sent = (type: string): Msg[] =>
    capture.send.mock.calls
      .map((c) => c[0] as Msg)
      .filter((m) => m.type === type);
  const say = (text: string) => {
    turns++;
    capture.emit({
      type: "speech_event",
      sessionId: "s1",
      event: { type: "user_speech_final", text },
    });
  };
  const chat = (text: string) => {
    turns++;
    capture.emit({
      type: "data_channel_message",
      sessionId: "s1",
      payload: JSON.stringify({ type: "chat", text }),
    });
  };
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

  async function boot(systemPrompt = STORE_PROMPT): Promise<unknown> {
    const config = JSON.parse(read("voicethere.llm.json"));
    defineAgent(
      createLlmAgent({
        config: {
          ...config,
          provider: "openai",
          apiKeySecret: "AGENT_TEST_KEY",
          speech: { coalesceMs: 0 },
          knowledge: {
            ...config.knowledge,
            embeddings: {
              ...config.knowledge.embeddings,
              apiKeySecret: "AGENT_TEST_KEY",
            },
          },
        },
        systemPrompt,
        provider,
        knowledge: { base: fakeKnowledge },
        env: () => ({
          AGENT_TEST_KEY: "secret-value",
          AGENT_SERVICE_URL: service.url.replace(/\/mcp$/, ""),
          AGENT_SERVICE_TOKEN: SERVICE_TOKEN,
        }),
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

  const priceCall = (product: string): LlmToolCall => ({
    id: "c1",
    name: "get_product_price",
    input: { product },
  });

  /** Greeting played, then a first exchange ("Hello") whose reply is unplayed. */
  async function greet(
    systemPrompt = STORE_PROMPT,
  ): Promise<{ replyTurn: unknown; before: number }> {
    const greetTurn = await boot(systemPrompt);
    speakResults(greetTurn, "played", 3000);
    script.push({ text: "Hi there. How can I help?" });
    say("Hello");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await vi.waitFor(() =>
      expect(
        sent("speak").filter((m) => m.turnId !== greetTurn).length,
      ).toBeGreaterThan(0),
    );
    const replyTurn = sent("speak").find((m) => m.turnId !== greetTurn)!.turnId;
    return { replyTurn, before: requests.length };
  }

  /**
   * Drives the harness into `shape`, sends `userText` and scripts one tool
   * round (`toolCall`, then `answer`). Returns the first request of the turn
   * and the answer-round request that follows the tool result.
   */
  async function drive(
    shape: Shape,
    userText: string,
    toolCall: LlmToolCall,
    answer: string,
    systemPrompt = STORE_PROMPT,
  ): Promise<{ first: LlmRequest; answer: LlmRequest }> {
    const { replyTurn, before } = await greet(systemPrompt);
    script.push({ toolCalls: [toolCall] }, { text: answer });
    if (shape === "settled") {
      speakResults(replyTurn, "played", 3000);
      say(userText);
    } else if (shape === "in-flight") {
      chat(userText);
    } else {
      interrupt(replyTurn, "Hi there.", "How can I help?");
      say(userText);
    }
    await vi.waitFor(() => expect(requests).toHaveLength(before + 2));
    return { first: requests[before]!, answer: requests[before + 1]! };
  }

  const meta = (promise: string, shape: string) => ({
    template: "llm-store-support",
    promise,
    shape,
    promptSha256: STORE_PROMPT_SHA,
  });

  const SHAPES: Shape[] = ["settled", "in-flight", "interrupted"];

  const ROLES: Record<Shape, string[]> = {
    settled: ["user", "assistant", "user", "assistant", "user"],
    "in-flight": ["user", "assistant", "user", "user"],
    interrupted: ["user", "assistant", "user", "assistant", "user"],
  };

  function expectShapeRoles(shape: Shape, req: LlmRequest, question: string) {
    expect(req.messages.map((m) => m.role)).toEqual(ROLES[shape]);
    const last = lastMessage(req);
    if (shape === "settled") {
      expect(textOf(last)).toBe(question);
      return;
    }
    // The unplayed reply is absent (in-flight) or cut at the played text
    // (interrupted); the last user message carries the interruption note.
    expect(textOf(last)).toContain(
      "(The caller interrupted your previous reply",
    );
    expect(textOf(last)).toContain(question);
    if (shape === "in-flight") {
      expect(textOf(last)).toContain('after: ""');
      expect(
        req.messages.some((m) => textOf(m) === "Hi there. How can I help?"),
      ).toBe(false);
    } else {
      expect(textOf(req.messages[3])).toBe("Hi there.");
      expect(textOf(last)).toContain('after: "Hi there');
    }
  }

  describe("S1: any price calls get_product_price", () => {
    it.each(SHAPES)("shape %s", async (shape) => {
      const q = "How much is the Ridgeline 2?";
      const { first } = await drive(
        shape,
        q,
        priceCall("ridgeline-2"),
        "Okay.",
      );
      expectStoreInstructions(first);
      expect(first.toolChoice).toBe("required");
      expectShapeRoles(shape, first, q);
      writeRequestFixture("S1", first, meta("S1", shape));
    });
  });

  describe("S2: the stated price is the tool's price", () => {
    it.each(["settled", "in-flight"] as Shape[])("shape %s", async (shape) => {
      const q = "How much is the Ridgeline 2?";
      const { answer } = await drive(
        shape,
        q,
        priceCall("ridgeline-2"),
        "Okay.",
      );
      expectStoreInstructions(answer);
      expect(answer.toolChoice).toBeUndefined();
      const last = lastMessage(answer);
      expect(last.role).toBe("tool");
      expect(JSON.stringify(last)).toContain("349");
      assertProviderOrder(answer.messages);
      writeRequestFixture("S2", answer, meta("S2", shape));
    });
  });

  describe("S3: a policy question calls search_knowledge", () => {
    it.each(["settled", "in-flight"] as Shape[])("shape %s", async (shape) => {
      const q = "How long does shipping take?";
      const { first, answer } = await drive(
        shape,
        q,
        {
          id: "c1",
          name: "search_knowledge",
          input: { query: "shipping time" },
        },
        "Okay.",
      );
      expectStoreInstructions(first);
      expect(first.system).toContain(SEARCH_INSTRUCTION);
      expect(first.toolChoice).toBe("required");
      expectShapeRoles(shape, first, q);
      expect(answer.toolChoice).toBeUndefined();
      expect(JSON.stringify(lastMessage(answer))).toContain("Delivery times");
      writeRequestFixture("S3", first, meta("S3", shape));
    });
  });

  describe("S4: a second product calls the tool again", () => {
    it("settled: Ridgeline answered and played, then the Basecamp 4", async () => {
      const { replyTurn, before } = await greet();
      script.push(
        { toolCalls: [priceCall("ridgeline-2")] },
        { text: "The Ridgeline 2 is three hundred and forty-nine dollars." },
      );
      speakResults(replyTurn, "played", 3000);
      say("How much is the Ridgeline 2?");
      await vi.waitFor(() => expect(requests).toHaveLength(before + 2));
      await vi.waitFor(() =>
        expect(
          sent("speak").some((m) =>
            String(m.text ?? "").includes("three hundred and forty-nine"),
          ),
        ).toBe(true),
      );
      const answerSpeak = sent("speak").find((m) =>
        String(m.text ?? "").includes("three hundred and forty-nine"),
      )!;
      speakResults(answerSpeak.turnId, "played", 4000);
      script.push({ toolCalls: [priceCall("basecamp-4")] }, { text: "Okay." });
      say("And the Basecamp 4?");
      await vi.waitFor(() => expect(requests).toHaveLength(before + 4));
      const req = requests[before + 2]!;
      expectStoreInstructions(req);
      expect(req.toolChoice).toBe("required");
      expect(textOf(lastMessage(req))).toBe("And the Basecamp 4?");
      assertProviderOrder(req.messages);
      expect(req.messages.map((m) => m.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
        "user",
        "assistant",
        "tool",
        "assistant",
        "user",
      ]);
      writeRequestFixture("S4", req, meta("S4", "settled"));
    });
  });

  describe("S5: chat while the post-tool answer is unplayed (2026-11-10)", () => {
    it("after-tool-chat", async () => {
      const { replyTurn, before } = await greet();
      speakResults(replyTurn, "played", 3000);
      script.push(
        { toolCalls: [priceCall("ridgeline-2")] },
        { text: "The Ridgeline 2 is three hundred and forty-nine dollars." },
      );
      say("How much is the Ridgeline 2?");
      await vi.waitFor(() => expect(requests).toHaveLength(before + 2));
      await vi.waitFor(() =>
        expect(
          sent("speak").some((m) =>
            String(m.text ?? "").includes("three hundred and forty-nine"),
          ),
        ).toBe(true),
      );
      script.push({ toolCalls: [priceCall("basecamp-4")] }, { text: "Okay." });
      chat("And the Basecamp 4?");
      await vi.waitFor(() => expect(requests).toHaveLength(before + 4));
      const req = requests[before + 2]!;
      expectStoreInstructions(req);
      assertProviderOrder(req.messages);
      expect(req.toolChoice).toBe("required");
      // The post-tool answer is the only turn in flight: it stays in history,
      // and the last user message carries the note with nothing played.
      expect(req.messages.map((m) => m.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
        "user",
        "assistant",
        "tool",
        "assistant",
        "user",
      ]);
      expect(textOf(req.messages[7])).toContain("three hundred and forty-nine");
      expect(textOf(lastMessage(req))).toContain('after: ""');
      expect(textOf(lastMessage(req))).toContain("And the Basecamp 4?");
      writeRequestFixture("S5", req, meta("S5", "after-tool-chat"));
    });
  });

  describe("instruction removal fails the matching assertion", () => {
    it.each([
      ["S1", STORE_INSTRUCTIONS.S1],
      ["S2", STORE_INSTRUCTIONS.S2],
    ])("%s: removing %j", async (_id, sentence) => {
      expect(STORE_PROMPT).toContain(sentence);
      const { first } = await drive(
        "settled",
        "How much is the Ridgeline 2?",
        priceCall("ridgeline-2"),
        "Okay.",
        STORE_PROMPT.replace(sentence, ""),
      );
      expect(() => expectStoreInstructions(first)).toThrow(sentence);
    });
  });
});
