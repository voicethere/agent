import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildAgentBundle } from "../src/build-bundle.js";
import { createFlowAgent } from "../src/flow/create-flow-agent.js";
import { openai } from "../src/llm/openai.js";
import {
  SESSION_START_INIT_DELAY_ENABLED_ENV,
  defineAgent,
  resetAgentIpcStateForTests,
} from "../src/runtime.js";
import { validateFlow, validateMocks } from "../src/flow/core/index.js";
import { LLM_PROVIDERS } from "../src/llm/catalog.js";
import { installProcessMessageCapture } from "./helpers/process-mock.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = join(root, "templates", "flow-agent");
const read = (f: string): unknown =>
  JSON.parse(readFileSync(join(templateDir, f), "utf8"));

describe("flow-agent template", () => {
  it("uses the catalog's cheap model and key name for every model it seeds", () => {
    // The route classifier forces a tool call; the catalog's cheapModel is the
    // one checked to support tool_choice (amazon/nova-micro-v1 does not).
    const flow = read("voicethere.flow.json") as {
      models: Record<
        string,
        { provider?: string; model?: string; apiKeySecret?: string }
      >;
    };
    const seeded = Object.values(flow.models).filter((m) => m.provider);
    expect(seeded.length).toBeGreaterThan(0);
    for (const m of seeded) {
      const entry = LLM_PROVIDERS[m.provider as keyof typeof LLM_PROVIDERS];
      expect(m.model).toBe(entry.cheapModel);
      expect(m.apiKeySecret).toBe(entry.apiKeyEnv);
    }
  });

  it("bundles with its json import", async () => {
    const dir = mkdtempSync(join(tmpdir(), "voicethere-flow-template-"));
    const outfile = join(dir, "agent.js");
    try {
      await buildAgentBundle({
        cwd: root,
        entry: "templates/flow-agent/agent.ts",
        outfile,
      });
      const source = readFileSync(outfile, "utf8");
      expect(source).toContain("Is this about billing or support?");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the seeded flow and mocks validate, and createFlowAgent accepts them", () => {
    const v = validateFlow(read("voicethere.flow.json"));
    expect(v.errors).toEqual([]);
    expect(validateMocks(read("voicethere.flow.mocks.json"), v.flow!).ok).toBe(
      true,
    );
    expect(() =>
      createFlowAgent({
        flow: read("voicethere.flow.json"),
        providers: [openai],
      }),
    ).not.toThrow();
  });

  describe("voice session on the template mocks", () => {
    const SESSION = "tpl-1";
    let capture: ReturnType<typeof installProcessMessageCapture>;

    beforeEach(() => {
      resetAgentIpcStateForTests();
      process.env[SESSION_START_INIT_DELAY_ENABLED_ENV] = "false";
      process.env.__CHILD_BUNDLE_PATH__ = "/tmp/agent.js";
      capture = installProcessMessageCapture();
    });
    afterEach(async () => {
      capture.emit({ type: "session_end", sessionId: SESSION });
      await new Promise((r) => setTimeout(r, 50));
      capture.restore();
      resetAgentIpcStateForTests();
      delete process.env[SESSION_START_INIT_DELAY_ENABLED_ENV];
      delete process.env.__CHILD_BUNDLE_PATH__;
    });

    const speaks = (): { text: unknown; requestId: unknown }[] =>
      capture.send.mock.calls
        .map((c) => c[0] as Record<string, unknown>)
        .filter((m) => m.type === "speak")
        .map((m) => ({ text: m.text, requestId: m.requestId }));

    it("greets and routes an invoice question to billing", async () => {
      defineAgent(
        createFlowAgent({
          flow: read("voicethere.flow.json"),
          mocks: read("voicethere.flow.mocks.json"),
          providers: [openai],
          env: () => ({}),
        }),
      );
      capture.emit({
        type: "session_start",
        sessionId: SESSION,
        env: { SESSION_ID: SESSION },
        speakControlAvailable: true,
      });
      await vi.waitFor(() => expect(speaks()).toHaveLength(1));
      expect(speaks()[0]!.text).toBe("Hi! Is this about billing or support?");
      capture.emit({
        type: "speak_result",
        sessionId: SESSION,
        requestId: speaks()[0]!.requestId,
        status: "played",
        playedMs: 100,
      });
      await vi.waitFor(() =>
        expect(
          capture.send.mock.calls.some(
            (c) =>
              (c[0] as any).message === "flow_step" &&
              (c[0] as any).fields?.nodeId === "ask",
          ),
        ).toBe(true),
      );
      capture.emit({
        type: "speech_event",
        sessionId: SESSION,
        event: {
          type: "user_speech_final",
          text: "I have a question about my invoice",
          utteranceId: "u1",
        },
      });
      await vi.waitFor(() => expect(speaks()).toHaveLength(2));
      expect(speaks()[1]!.text).toBe(
        "Thanks. A billing specialist will follow up on your invoice by email.",
      );
    });
  });
});
