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
    expect(
      parseBoardMessage({ type: "board.join", room: "room-abc1" }),
    ).toEqual({ type: "board.join", room: "room-abc1" });
    expect(parseBoardMessage({ type: "chat", text: "hi" })).toBeNull();
    expect(parseBoardMessage({ type: "note.add" })).toBeNull();
    expect(parseBoardMessage({ type: "note.remove" })).toBeNull();
    expect(parseBoardMessage("note.add")).toBeNull();
    expect(parseBoardMessage(null)).toBeNull();
  });
});

describe("llm-board board.join", () => {
  it("rejects room ids outside /^[a-z0-9-]{6,40}$/", () => {
    for (const room of [
      "AB",
      "../x",
      "short",
      "UPPER-case1",
      "has space1",
      "a".repeat(41),
      "s:peer-1",
      "",
      7,
      null,
    ]) {
      expect(
        parseBoardMessage({ type: "board.join", room }),
        String(room),
      ).toBeNull();
    }
    expect(parseBoardMessage({ type: "board.join" })).toBeNull();
    expect(
      parseBoardMessage({ type: "board.join", room: "a".repeat(40) }),
    ).not.toBeNull();
    expect(
      parseBoardMessage({ type: "board.join", room: "abc-12" }),
    ).not.toBeNull();
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
  const A = "peer-a";
  const B = "peer-b";
  const C = "peer-c";
  const started: string[] = [];
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
    for (const id of started.splice(0)) {
      capture.emit({ type: "session_end", sessionId: id });
    }
    capture.restore();
    resetAgentIpcStateForTests();
    delete process.env[SESSION_START_INIT_DELAY_ENABLED_ENV];
    delete process.env.__CHILD_BUNDLE_PATH__;
  });

  type Sent = { sessionId: string; payload: Record<string, unknown> };
  const sentToClients = (): Sent[] =>
    capture.send.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((m) => m.type === "send_to_client")
      .map((m) => ({
        sessionId: m.sessionId as string,
        payload: m.payload as Record<string, unknown>,
      }));
  /** Board messages that reached one session. */
  const boardsFor = (id: string) =>
    sentToClients()
      .filter((m) => m.sessionId === id && m.payload.type === "board")
      .map((m) => m.payload as { notes: { text: string; author: string }[] });

  /**
   * A fake model. Each new user turn takes the next scripted tool round, if
   * any; the request after a tool result just ends the turn. Tool results are
   * kept in `toolResults`.
   */
  function fakeProvider(rounds: LlmToolCall[][]) {
    const requests: LlmRequest[] = [];
    const toolResults: string[] = [];
    const queue = [...rounds];
    const provider: LlmProvider = {
      id: "openai",
      stream(req) {
        requests.push(structuredClone({ ...req, signal: undefined }));
        const last = req.messages.at(-1);
        let calls: LlmToolCall[] = [];
        if (last?.role === "tool") {
          for (const r of last.results) toolResults.push(r.content);
        } else {
          calls = queue.shift() ?? [];
        }
        return (async function* () {
          yield calls.length > 0
            ? {
                type: "done" as const,
                stopReason: "tool_calls" as const,
                text: "",
                toolCalls: calls,
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
    return { provider, requests, toolResults };
  }

  async function startSession(id: string) {
    capture.emit({
      type: "session_start",
      sessionId: id,
      env: { SESSION_ID: id },
      speakControlAvailable: true,
    });
    started.push(id);
    await vi.waitFor(() =>
      expect(
        capture.send.mock.calls.some((c) => {
          const m = c[0] as { type?: string; sessionId?: string };
          return m.type === "session_start_ack" && m.sessionId === id;
        }),
      ).toBe(true),
    );
  }

  async function boot(rounds: LlmToolCall[][], sessions: string[] = [A]) {
    const fake = fakeProvider(rounds);
    defineAgent(
      createBoardAgent({
        provider: fake.provider,
        env: () => ({ AGENT_OPENROUTER_API_KEY: "unused" }),
      }),
    );
    for (const id of sessions) await startSession(id);
    capture.send.mockClear();
    return fake;
  }

  const dc = (sessionId: string, payload: unknown) =>
    capture.emit({
      type: "data_channel_message",
      sessionId,
      payload: JSON.stringify(payload),
    });
  /** Joins and waits until the join has been handled (the room gets a board). */
  async function join(id: string, room: string) {
    const before = boardsFor(id).length;
    dc(id, { type: "board.join", room });
    await vi.waitFor(() =>
      expect(boardsFor(id).length).toBeGreaterThan(before),
    );
  }
  const end = (id: string) => {
    capture.emit({ type: "session_end", sessionId: id });
    started.splice(started.indexOf(id), 1);
  };

  it("a note.add from the client plus add_note from the model give two notes in one board broadcast", async () => {
    const { requests } = await boot([
      [{ id: "c1", name: "add_note", input: { text: "Ship the beta" } }],
    ]);
    dc(A, { type: "note.add", text: "Write the docs" });
    await vi.waitFor(() => expect(boardsFor(A)).toHaveLength(1));
    expect(boardsFor(A)[0]).toMatchObject({
      notes: [{ text: "Write the docs", author: "user" }],
    });
    expect(requests).toHaveLength(0);

    dc(A, { type: "chat", text: "please add a note" });
    await vi.waitFor(() =>
      expect(boardsFor(A).length).toBeGreaterThanOrEqual(2),
    );
    expect(
      boardsFor(A)
        .at(-1)
        ?.notes.map((n) => [n.text, n.author]),
    ).toEqual([
      ["Write the docs", "user"],
      ["Ship the beta", "ai"],
    ]);
  });

  it("a chat message still reaches the LLM with the user's text", async () => {
    const { requests } = await boot([]);
    dc(A, { type: "chat", text: "summarise the board" });
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(JSON.stringify(requests[0]?.messages)).toContain(
      "summarise the board",
    );
    expect(boardsFor(A)).toHaveLength(0);
  });

  it("two sessions in room-abc1 both get A's note; a session in room-xyz9 gets nothing and sees an empty board", async () => {
    const { toolResults } = await boot(
      [[{ id: "c1", name: "list_notes", input: {} }]],
      [A, B, C],
    );
    await join(A, "room-abc1");
    await join(B, "room-abc1");
    await join(C, "room-xyz9");
    capture.send.mockClear();

    dc(A, { type: "note.add", text: "Only for abc1" });
    await vi.waitFor(() => {
      expect(boardsFor(A)).toHaveLength(1);
      expect(boardsFor(B)).toHaveLength(1);
    });
    expect(boardsFor(A)[0]?.notes.map((n) => n.text)).toEqual([
      "Only for abc1",
    ]);
    expect(boardsFor(B)[0]?.notes.map((n) => n.text)).toEqual([
      "Only for abc1",
    ]);
    expect(boardsFor(C)).toHaveLength(0);

    dc(C, { type: "chat", text: "what is on the board" });
    await vi.waitFor(() => expect(toolResults).toHaveLength(1));
    expect(toolResults[0]).toBe("The board is empty.");
  });

  it("add_note from the model for B lands in the shared room board", async () => {
    await boot(
      [[{ id: "c1", name: "add_note", input: { text: "From the model" } }]],
      [A, B],
    );
    await join(A, "room-abc1");
    await join(B, "room-abc1");
    capture.send.mockClear();

    dc(B, { type: "chat", text: "add a note" });
    await vi.waitFor(() => {
      expect(boardsFor(A)).toHaveLength(1);
      expect(boardsFor(B)).toHaveLength(1);
    });
    expect(boardsFor(A)[0]?.notes).toMatchObject([
      { text: "From the model", author: "ai" },
    ]);
  });

  it("board.sync answers the requester only", async () => {
    await boot([], [A, B]);
    await join(A, "room-abc1");
    await join(B, "room-abc1");
    capture.send.mockClear();
    dc(A, { type: "board.sync" });
    await vi.waitFor(() => expect(boardsFor(A)).toHaveLength(1));
    expect(boardsFor(B)).toHaveLength(0);
  });

  it("joining a new room leaves the old one", async () => {
    await boot([], [A, B]);
    await join(A, "room-abc1");
    await join(B, "room-abc1");
    await join(A, "room-xyz9");
    capture.send.mockClear();
    dc(A, { type: "note.add", text: "Moved on" });
    await vi.waitFor(() => expect(boardsFor(A)).toHaveLength(1));
    expect(boardsFor(B)).toHaveLength(0);
  });

  it("after both sessions end the room's board is gone and a new join starts empty", async () => {
    await boot([], [A, B]);
    await join(A, "room-abc1");
    await join(B, "room-abc1");
    dc(A, { type: "note.add", text: "Will be dropped" });
    await vi.waitFor(() => expect(boardsFor(B).at(-1)?.notes).toHaveLength(1));
    end(A);
    // B is still in the room, so the board survives.
    capture.send.mockClear();
    dc(B, { type: "board.sync" });
    await vi.waitFor(() => expect(boardsFor(B)).toHaveLength(1));
    expect(boardsFor(B)[0]?.notes).toHaveLength(1);
    end(B);

    await startSession(A);
    capture.send.mockClear();
    await join(A, "room-abc1");
    await vi.waitFor(() => expect(boardsFor(A)).toHaveLength(1));
    expect(boardsFor(A)[0]?.notes).toEqual([]);
  });
});
