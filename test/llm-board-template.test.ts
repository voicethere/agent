import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { buildAgentBundle } from "../src/build-bundle.js";
import { validateLlmAgentConfig } from "../src/llm/agent/config.js";
import { listTemplates } from "../src/templates/index.js";
import type { LlmProvider, LlmRequest, LlmToolCall } from "../src/llm/types.js";
import {
  defineAgent,
  SESSION_START_INIT_DELAY_ENABLED_ENV,
  resetAgentIpcStateForTests,
} from "../src/runtime.js";
import { installProcessMessageCapture } from "./helpers/process-mock.js";
import {
  Board,
  MAX_NOTES,
  parseBoardMessage,
} from "../templates/llm-board/board.js";

// Vitest's alias maps only the package root; point the subpaths at src.
vi.mock("@voicethere/agent/llm", () => import("../src/llm/index.js"));
vi.mock("@voicethere/agent/llm/openai", () => import("../src/llm/openai.js"));

// Vite does not load .md imports; the bundle test below covers the real file.
vi.mock("../templates/llm-board/prompt.md", () => ({
  default: "You are a test facilitator.",
}));

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const templatesDir = join(root, "templates");
const templateDir = join(templatesDir, "llm-board");

describe("llm-board board.ts", () => {
  it("adds, updates and removes notes", () => {
    const b = new Board();
    const a = b.add({ text: "First", author: "user" });
    expect(a.ok && a.value.color).toBe("yellow");
    const id = a.ok ? a.value.id : "";
    const u = b.update(id, { text: "Changed", color: "blue", x: 0.5 });
    expect(u).toMatchObject({
      ok: true,
      value: { text: "Changed", color: "blue", x: 0.5 },
    });
    expect(b.update("nope", { text: "x" })).toEqual({
      ok: false,
      error: "No note with id nope.",
    });
    expect(b.remove(id)).toBe(true);
    expect(b.remove(id)).toBe(false);
    expect(b.list()).toEqual([]);
  });

  it("refuses the 61st note with 'board is full'", () => {
    const b = new Board();
    for (let i = 0; i < MAX_NOTES; i++) {
      expect(b.add({ text: `n${i}`, author: "user" }).ok).toBe(true);
    }
    expect(b.add({ text: "one more", author: "user" })).toEqual({
      ok: false,
      error: "board is full",
    });
  });

  it("rejects 201 character text and accepts 200", () => {
    const b = new Board();
    expect(b.add({ text: "a".repeat(201), author: "user" }).ok).toBe(false);
    expect(b.add({ text: "a".repeat(200), author: "user" }).ok).toBe(true);
    expect(b.add({ text: "", author: "user" }).ok).toBe(false);
  });

  it("places new notes on different free slots", () => {
    const b = new Board();
    const p = b.add({ text: "a", author: "ai" });
    const q = b.add({ text: "b", author: "ai" });
    expect(
      p.ok && q.ok && (p.value.x !== q.value.x || p.value.y !== q.value.y),
    ).toBe(true);
  });

  it("parses board messages and returns null for anything else", () => {
    expect(
      parseBoardMessage({ type: "note.add", text: "hi", color: "pink" }),
    ).toEqual({
      type: "note.add",
      text: "hi",
      color: "pink",
    });
    expect(
      parseBoardMessage({ type: "note.update", id: "n1", x: 0.2 }),
    ).toEqual({
      type: "note.update",
      id: "n1",
      x: 0.2,
    });
    expect(parseBoardMessage({ type: "note.remove", id: "n1" })).toEqual({
      type: "note.remove",
      id: "n1",
    });
    expect(parseBoardMessage({ type: "board.sync" })).toEqual({
      type: "board.sync",
    });
    expect(parseBoardMessage({ type: "chat", text: "hi" })).toBeNull();
    expect(parseBoardMessage({ type: "note.add" })).toBeNull();
    expect(parseBoardMessage({ type: "note.remove" })).toBeNull();
    expect(parseBoardMessage("note.add")).toBeNull();
    expect(parseBoardMessage(null)).toBeNull();
  });
});

describe("llm-board template", () => {
  it("is a creatable product template and ships every listed file", () => {
    const template = listTemplates({ kind: "product" }).find(
      (t) => t.id === "llm-board",
    );
    expect(template).toBeDefined();
    expect(template?.seedOnCreate).toBe(true);
    expect(template?.title).toBe("Collaborative board + AI");
    expect(template?.entry).toBe("llm-board/agent.ts");
    expect(template?.sourceFiles).toContain("llm-board/board.ts");
    for (const f of template?.sourceFiles ?? []) {
      expect(existsSync(join(templatesDir, f)), f).toBe(true);
    }
  });

  it("config validates with knowledge off", () => {
    const config = JSON.parse(
      readFileSync(join(templateDir, "voicethere.llm.json"), "utf8"),
    );
    const result = validateLlmAgentConfig(config);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(config.knowledge.store).toBe("off");
    expect(config.provider).toBe("openrouter");
  });

  it("bundles with the prompt, greeting and tools", async () => {
    const dir = mkdtempSync(join(tmpdir(), "voicethere-board-bundle-"));
    const outfile = join(dir, "agent.js");
    try {
      await buildAgentBundle({
        cwd: root,
        entry: "templates/llm-board/agent.ts",
        outfile,
      });
      const source = readFileSync(outfile, "utf8");
      expect(source).toContain("I'm your board facilitator");
      expect(source).toContain("facilitator of a shared brainstorming board");
      for (const t of ["list_notes", "add_note", "update_note"]) {
        expect(source).toContain(t);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("llm-board agent wiring", () => {
  const SESSION = "peer-1";
  let capture: ReturnType<typeof installProcessMessageCapture>;
  let createBoardAgent: (
    over: Record<string, unknown>,
  ) => Parameters<typeof defineAgent>[0];

  // The template calls defineAgent when imported. Import it with process.on
  // captured and thrown away, so only the agent each test defines is live.
  beforeAll(async () => {
    const importCapture = installProcessMessageCapture();
    // Variable specifier: the template's own imports (extensionless, .md, .json)
    // are bundler-style and not for the test tsconfig to resolve.
    const agentPath = "../templates/llm-board/agent.js";
    ({ createBoardAgent } = await import(/* @vite-ignore */ agentPath));
    importCapture.restore();
  });

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

  const payloads = (): Record<string, unknown>[] =>
    allPayloads().filter((p) => p.type === "board");
  const allPayloads = (): Record<string, unknown>[] =>
    capture.send.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((m) => m.type === "send_to_client")
      .map((m) => m.payload as Record<string, unknown>);

  function fakeProvider(toolCalls: LlmToolCall[]) {
    const requests: LlmRequest[] = [];
    let n = 0;
    const provider: LlmProvider = {
      id: "openai",
      stream(req) {
        requests.push(structuredClone({ ...req, signal: undefined }));
        const first = n === 0 && toolCalls.length > 0;
        n += 1;
        return (async function* () {
          yield first
            ? {
                type: "done" as const,
                stopReason: "tool_calls" as const,
                text: "",
                toolCalls,
                usage: { inputTokens: 1, outputTokens: 1 },
              }
            : {
                type: "done" as const,
                stopReason: "end" as const,
                text: "Done.",
                toolCalls: [],
                usage: { inputTokens: 1, outputTokens: 1 },
              };
        })();
      },
    };
    return { provider, requests };
  }

  async function boot(toolCalls: LlmToolCall[]) {
    const fake = fakeProvider(toolCalls);
    defineAgent(
      createBoardAgent({
        provider: fake.provider,
        env: () => ({ AGENT_OPENROUTER_API_KEY: "unused" }),
      }),
    );
    capture.emit({
      type: "session_start",
      sessionId: SESSION,
      env: { SESSION_ID: SESSION },
      speakControlAvailable: true,
    });
    await vi.waitFor(() =>
      expect(
        capture.send.mock.calls.some(
          (c) => (c[0] as { type?: string }).type === "session_start_ack",
        ),
      ).toBe(true),
    );
    capture.send.mockClear();
    return fake;
  }

  const dc = (payload: unknown) =>
    capture.emit({
      type: "data_channel_message",
      sessionId: SESSION,
      payload: JSON.stringify(payload),
    });

  it("a note.add from the client plus add_note from the model give two notes in one board broadcast", async () => {
    const { requests } = await boot([
      {
        id: "c1",
        name: "add_note",
        input: { text: "Ship the beta" },
      },
    ]);
    dc({ type: "note.add", text: "Write the docs" });
    await vi.waitFor(() => expect(payloads()).toHaveLength(1));
    expect(payloads()[0]).toMatchObject({
      type: "board",
      notes: [{ text: "Write the docs", author: "user" }],
    });
    expect(requests).toHaveLength(0);

    dc({ type: "chat", text: "please add a note" });
    await vi.waitFor(() => {
      const boards = payloads();
      expect(boards.length).toBeGreaterThanOrEqual(2);
    });
    const last = payloads()
      .filter((p) => p.type === "board")
      .at(-1) as {
      notes: { text: string; author: string }[];
    };
    expect(last.notes.map((n) => [n.text, n.author])).toEqual([
      ["Write the docs", "user"],
      ["Ship the beta", "ai"],
    ]);
  });

  it("a chat message still reaches the LLM with the user's text", async () => {
    const { requests } = await boot([]);
    dc({ type: "chat", text: "summarise the board" });
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(JSON.stringify(requests[0]?.messages)).toContain(
      "summarise the board",
    );
    expect(payloads()).toHaveLength(0);
  });
});
