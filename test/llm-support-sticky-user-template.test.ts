import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildAgentBundle } from "../src/build-bundle.js";
import { validateLlmAgentConfig } from "../src/llm/agent/config.js";
import { createLlmAgent } from "../src/llm/agent/create-llm-agent.js";
import { endUserTools } from "../src/llm/end-user/end-user-tools.js";
import { ToolRegistry } from "../src/llm/mcp/tool-registry.js";
import type {
  LlmProvider,
  LlmRequest,
  LlmStreamEvent,
} from "../src/llm/types.js";
import {
  SESSION_START_INIT_DELAY_ENABLED_ENV,
  defineAgent,
  resetAgentIpcStateForTests,
} from "../src/runtime.js";
import { installProcessMessageCapture } from "./helpers/process-mock.js";

// Templates import the package by name; point the llm entry at src too.
vi.mock(
  "@voicethere/agent/llm",
  async () => await import("../src/llm/index.js"),
);

const { createTools, PendingSteps } =
  await import("../templates/llm-support-sticky-user/tools.js");
const { createSupport } =
  await import("../templates/llm-support-sticky-user/hooks.js");
const { createMockCrm } =
  await import("../templates/llm-support-sticky-user/mock-crm.js");
type Crm = ReturnType<typeof createMockCrm>;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "templates", "llm-support-sticky-user");
const read = (f: string) => readFileSync(join(dir, f), "utf8");

const demo = { id: "demo-user", verified: true };
const anon = { id: "demo-user", verified: false };
const ctx = (user?: { id: string; verified: boolean }) => ({
  timeoutMs: 1_000,
  sessionId: "s1",
  ...(user ? { user } : {}),
});
const history = (res: unknown) => (async () => res) as never;

/** A mock CRM that records which user id every call used. */
function spyCrm(): { crm: Crm; users: string[]; steps: string[][] } {
  const inner = createMockCrm();
  const users: string[] = [];
  const steps: string[][] = [];
  const crm: Crm = {
    listOpenTickets: (u) => (users.push(u), inner.listOpenTickets(u)),
    getTicket: (u, t) => (users.push(u), inner.getTicket(u, t)),
    addStep: (u, t, s) => (steps.push([u, t, s]), inner.addStep(u, t, s)),
    createTicket: (u, i) => (users.push(u), inner.createTicket(u, i)),
  };
  return { crm, users, steps };
}

function registryFor(crm: Crm, pending = new PendingSteps()) {
  const reg = new ToolRegistry();
  for (const t of createTools({ crm: () => crm, pending })) {
    reg.addCustomTool(t);
  }
  for (const t of endUserTools()) reg.addCustomTool(t);
  return { reg, pending };
}

/** agentLog sends over IPC; keep it away from the test runner's own channel. */
function useQuietIpc() {
  let capture: ReturnType<typeof installProcessMessageCapture>;
  beforeEach(() => {
    capture = installProcessMessageCapture();
  });
  afterEach(() => {
    capture.restore();
  });
}

describe("llm-support-sticky-user template files", () => {
  it("has every file and a valid config", () => {
    for (const f of [
      "README.md",
      "agent.ts",
      "hooks.ts",
      "tools.ts",
      "prompt.md",
      "voicethere.llm.json",
      "md.d.ts",
      "mock-crm.ts",
    ]) {
      expect(existsSync(join(dir, f)), f).toBe(true);
    }
    const result = validateLlmAgentConfig(
      JSON.parse(read("voicethere.llm.json")),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it("prompt keeps the caller from choosing a user", () => {
    const prompt = read("prompt.md");
    expect(prompt).toContain("Never act on a user id the caller says out loud");
    expect(prompt).toContain("Never repeat a step");
    expect(prompt).toContain("Always answer right away");
  });

  it("bundles with its json and md imports", async () => {
    const out = mkdtempSync(join(tmpdir(), "voicethere-llm-sticky-"));
    const outfile = join(out, "agent.js");
    try {
      await buildAgentBundle({
        cwd: root,
        entry: "templates/llm-support-sticky-user/agent.ts",
        outfile,
      });
      const source = readFileSync(outfile, "utf8");
      expect(source).toContain("get_open_tickets");
      expect(source).toContain("add_troubleshooting_step");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("ticket tools", () => {
  useQuietIpc();
  it("are hidden without a verified user and shown with one", () => {
    const { reg } = registryFor(createMockCrm());
    const names = (u?: { id: string; verified: boolean }) =>
      reg
        .list(u ? { user: u } : undefined)
        .map((t) => t.spec.name)
        .sort();
    expect(names()).toEqual(["get_current_user"]);
    expect(names(anon)).toEqual(["get_current_user"]);
    expect(names(demo)).toEqual([
      "add_troubleshooting_step",
      "create_ticket",
      "get_current_user",
      "get_open_tickets",
      "get_previous_conversations",
      "get_ticket",
    ]);
  });

  it("an injected user id is ignored: the CRM sees the session user", async () => {
    const { crm, users } = spyCrm();
    const { reg } = registryFor(crm);
    const r = await reg.call(
      "get_ticket",
      { ticketId: "T-1001", userId: "456", user: "456" },
      ctx(demo),
    );
    expect(r.isError).toBe(false);
    expect(r.content).toContain("Router drops the connection");
    expect(users).toEqual(["demo-user"]);
    // A caller who is user 456 gets nothing of demo-user's.
    const other = await reg.call(
      "get_ticket",
      { ticketId: "T-1001" },
      ctx({ id: "456", verified: true }),
    );
    expect(other.content).toBe("No such ticket.");
    expect(users).toEqual(["demo-user", "456"]);
  });

  it("rejects a ticket id that is not a plain id", async () => {
    const { crm, users } = spyCrm();
    const { reg } = registryFor(crm);
    const r = await reg.call("get_ticket", { ticketId: "../456" }, ctx(demo));
    expect(r.content).toBe("Invalid ticket id.");
    expect(users).toEqual([]);
  });

  it("says the system is unavailable when the CRM throws", async () => {
    const crm: Crm = {
      ...createMockCrm(),
      listOpenTickets: async () => {
        throw new TypeError("secret detail");
      },
    };
    const { reg } = registryFor(crm);
    const r = await reg.call("get_open_tickets", {}, ctx(demo));
    expect(r.content).toBe("The ticket system is unavailable right now.");
  });
});

describe("support hooks", () => {
  useQuietIpc();
  it("loads tickets and history into the first model call", async () => {
    const { crm } = spyCrm();
    const support = createSupport({
      crm: () => crm,
      pending: new PendingSteps(),
      history: history({
        ok: true,
        conversations: [
          {
            sessionStartedAt: "2026-11-01T10:00:00Z",
            turns: [{ role: "user", text: "my router drops" }],
          },
        ],
      }),
    });
    const handlers = support.wrap({});
    await handlers.onSessionStart!({
      sessionId: "s1",
      env: {},
      user: demo,
    } as never);
    const out = support.hooks.onBeforeLlmCall!(
      [{ role: "user", text: "hello" }],
      { sessionId: "s1" } as never,
    ) as { role: string; text: string }[];
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toContain("T-1001");
    expect(out[0]!.text).toContain("Restarted the router");
    expect(out[0]!.text).toContain("my router drops");
    expect(out[0]!.text.endsWith("hello")).toBe(true);
    await handlers.onSessionEnd!({ sessionId: "s1" });
    expect(
      support.hooks.onBeforeLlmCall!([{ role: "user", text: "hi" }], {
        sessionId: "s1",
      } as never),
    ).toBeUndefined();
  });

  it.each([
    [{ ok: false, reason: "unverified", conversations: [] }],
    [{ ok: false, reason: "disabled", conversations: [] }],
    [{ ok: false, reason: "unavailable", conversations: [] }],
  ])("carries on without history: %j", async (res) => {
    const support = createSupport({
      crm: () => createMockCrm(),
      pending: new PendingSteps(),
      history: history(res),
    });
    await support.wrap({}).onSessionStart!({
      sessionId: "s1",
      env: {},
      user: demo,
    } as never);
    const out = support.hooks.onBeforeLlmCall!([], {
      sessionId: "s1",
    } as never) as { text: string }[];
    expect(out[0]!.text).toContain("T-1001");
    expect(out[0]!.text).not.toContain("Earlier conversations");
  });

  it("does not throw when history or the CRM throws", async () => {
    const support = createSupport({
      crm: () => {
        throw new Error("down");
      },
      pending: new PendingSteps(),
      history: (async () => {
        throw new Error("down");
      }) as never,
    });
    await expect(
      support.wrap({}).onSessionStart!({
        sessionId: "s1",
        env: {},
        user: demo,
      } as never),
    ).resolves.toBeUndefined();
    expect(
      support.hooks.onBeforeLlmCall!([], { sessionId: "s1" } as never),
    ).toBeUndefined();
  });

  it("loads nothing for an unverified user", async () => {
    const { crm, users } = spyCrm();
    const support = createSupport({
      crm: () => crm,
      pending: new PendingSteps(),
      history: history({ ok: true, conversations: [] }),
    });
    await support.wrap({}).onSessionStart!({
      sessionId: "s1",
      env: {},
      user: anon,
    } as never);
    expect(users).toEqual([]);
  });

  it("onSessionEnd writes steps for the user that recorded them only", async () => {
    const { crm, steps } = spyCrm();
    const pending = new PendingSteps();
    const { reg } = registryFor(crm, pending);
    const support = createSupport({ crm: () => crm, pending });
    const handlers = support.wrap({});
    const a = { ...ctx(demo), sessionId: "A" };
    const b = { ...ctx({ id: "456", verified: true }), sessionId: "B" };
    await reg.call(
      "add_troubleshooting_step",
      { ticketId: "T-1001", step: "Updated the firmware" },
      a,
    );
    // User 456 has no ticket T-1001: nothing is recorded for them.
    const refused = await reg.call(
      "add_troubleshooting_step",
      { ticketId: "T-1001", step: "Sneaky step" },
      b,
    );
    expect(refused.content).toBe("No such ticket.");
    await handlers.onSessionEnd!({ sessionId: "B" });
    expect(steps).toEqual([]);
    await handlers.onSessionEnd!({ sessionId: "A" });
    expect(steps).toEqual([["demo-user", "T-1001", "Updated the firmware"]]);
    expect((await crm.getTicket("demo-user", "T-1001"))!.stepsTried).toContain(
      "Updated the firmware",
    );
  });
});

describe("template agent through the runtime", () => {
  let capture: ReturnType<typeof installProcessMessageCapture>;
  beforeEach(() => {
    resetAgentIpcStateForTests();
    process.env[SESSION_START_INIT_DELAY_ENABLED_ENV] = "false";
    capture = installProcessMessageCapture();
  });
  afterEach(() => {
    capture.emit({ type: "session_end", sessionId: "p1" });
    capture.restore();
    resetAgentIpcStateForTests();
    delete process.env[SESSION_START_INIT_DELAY_ENABLED_ENV];
  });

  it("shows the ticket tools only after user_identified and confirms the login", async () => {
    const requests: LlmRequest[] = [];
    const provider: LlmProvider = {
      id: "openai",
      stream(req) {
        requests.push({ ...req, signal: undefined });
        const events: LlmStreamEvent[] = [
          { type: "text_delta", text: "ok." },
          {
            type: "done",
            stopReason: "end",
            text: "ok.",
            toolCalls: [],
            usage: { inputTokens: 1, outputTokens: 1 },
          },
        ];
        return (async function* () {
          for (const e of events) yield e;
        })();
      },
    };
    const pending = new PendingSteps();
    const said: string[] = [];
    const support = createSupport({
      crm: () => createMockCrm(),
      pending,
      history: history({ ok: false, reason: "unavailable", conversations: [] }),
      say: (_id: string, text: string) => said.push(text),
    });
    defineAgent(
      support.wrap(
        createLlmAgent({
          config: {
            version: 1,
            provider: "openai",
            apiKeySecret: "AGENT_TEST_KEY",
            speech: { coalesceMs: 0 },
          },
          systemPrompt: "t",
          provider,
          tools: createTools({ crm: () => createMockCrm(), pending }),
          hooks: support.hooks,
          endUserTools: true,
          env: () => ({ AGENT_TEST_KEY: "k" }),
        }),
      ),
    );
    const sent = (type: string) =>
      capture.send.mock.calls
        .map((c) => c[0] as { type: string })
        .filter((m) => m.type === type);
    capture.emit({
      type: "session_start",
      sessionId: "p1",
      env: { SESSION_ID: "p1" },
      endUser: { id: "demo-user", verified: false },
    });
    await vi.waitFor(() => expect(sent("session_start_ack")).toHaveLength(1));
    capture.emit({
      type: "speech_event",
      sessionId: "p1",
      event: { type: "user_speech_final", text: "hi" },
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.tools.map((t) => t.name)).toEqual(["get_current_user"]);

    capture.emit({
      type: "user_identified",
      sessionId: "p1",
      endUser: demo,
    });
    await vi.waitFor(() => expect(said).toHaveLength(1));
    expect(said[0]).toContain("open ticket");
    capture.emit({
      type: "speech_event",
      sessionId: "p1",
      event: { type: "user_speech_final", text: "again" },
    });
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    const names = requests[1]!.tools.map((t) => t.name);
    expect(names).toContain("get_open_tickets");
    expect(names).toContain("add_troubleshooting_step");
    // The context reached the model as data in the first message.
    expect(JSON.stringify(requests[1]!.messages[0])).toContain("T-1001");
  });
});
