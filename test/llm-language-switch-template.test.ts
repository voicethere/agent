import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildAgentBundle } from "../src/build-bundle.js";
import { validateLlmAgentConfig } from "../src/llm/agent/config.js";
import { createLlmAgent } from "../src/llm/agent/create-llm-agent.js";
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
import { listTemplates } from "../src/templates/index.js";
import {
  SUPPORTED_LANGUAGES,
  languageSwitchAgent,
  unsupportedNotice,
} from "../templates/llm-language-switch/language.js";
import { installProcessMessageCapture } from "./helpers/process-mock.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const templatesDir = join(root, "templates");
const templateDir = join(templatesDir, "llm-language-switch");

type Msg = Record<string, unknown>;

function readConfig() {
  return JSON.parse(
    readFileSync(join(templateDir, "voicethere.llm.json"), "utf8"),
  );
}

describe("llm-language-switch template files", () => {
  it("is a creatable product template and ships every listed file", () => {
    const template = listTemplates({ kind: "product" }).find(
      (t) => t.id === "llm-language-switch",
    );
    expect(template).toBeDefined();
    expect(template?.seedOnCreate).toBe(true);
    expect(template?.entry).toBe("llm-language-switch/agent.ts");
    expect(template?.sourceFiles).toContain("llm-language-switch/language.ts");
    for (const f of template?.sourceFiles ?? []) {
      expect(existsSync(join(templatesDir, f)), f).toBe(true);
    }
  });

  it("config validates and uses the OpenRouter key secret", () => {
    const config = readConfig();
    const result = validateLlmAgentConfig(config);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(config.provider).toBe("openrouter");
    expect(config.apiKeySecret).toBe("AGENT_OPENROUTER_API_KEY");
    expect(config.greeting.text).toBe(
      "Hi! Talk to me in English, German, Spanish or French. Switch any time and I'll follow.",
    );
  });

  it("bundles with the prompt, greeting and language notice text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "voicethere-lang-switch-bundle-"));
    const outfile = join(dir, "agent.js");
    try {
      await buildAgentBundle({
        cwd: root,
        entry: "templates/llm-language-switch/agent.ts",
        outfile,
      });
      const source = readFileSync(outfile, "utf8");
      expect(source).toContain("Switch any time and I'll follow.");
      expect(source).toContain("travel-help assistant");
      expect(source).toContain("Reply only in");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("unsupportedNotice", () => {
  it("names the heard language and the supported ones in the current language", () => {
    expect(unsupportedNotice("it", "en")).toBe(
      "I heard Italian. I can talk with you in English, German, Spanish or French.",
    );
    expect(unsupportedNotice("ru", "de")).toContain(
      "Ich habe Russisch gehört.",
    );
    expect(unsupportedNotice("it", "es")).toContain("Escuché italiano.");
    expect(unsupportedNotice("it", "fr")).toContain("J'ai entendu italien.");
  });

  it("supported list matches the project allowlist in the README", () => {
    expect(SUPPORTED_LANGUAGES).toEqual(["en", "de", "es", "fr"]);
    expect(readFileSync(join(templateDir, "README.md"), "utf8")).toContain(
      '`["en", "de", "es", "fr"]`',
    );
  });
});

describe("llm-language-switch behavior", () => {
  let capture: ReturnType<typeof installProcessMessageCapture>;
  const requests: LlmRequest[] = [];

  beforeEach(() => {
    resetAgentIpcStateForTests();
    process.env[SESSION_START_INIT_DELAY_ENABLED_ENV] = "false";
    process.env.__CHILD_BUNDLE_PATH__ = "/tmp/agent.js";
    capture = installProcessMessageCapture();
    requests.length = 0;
  });

  afterEach(() => {
    for (const id of ["s1", "s2"]) {
      capture.emit({ type: "session_end", sessionId: id });
    }
    capture.restore();
    resetAgentIpcStateForTests();
    delete process.env[SESSION_START_INIT_DELAY_ENABLED_ENV];
    delete process.env.__CHILD_BUNDLE_PATH__;
  });

  const sent = (type?: string): Msg[] => {
    const all = capture.send.mock.calls.map((c) => c[0] as Msg);
    return type ? all.filter((m) => m.type === type) : all;
  };
  const client = (type: string): Msg[] =>
    sent("send_to_client")
      .map((m) => m.payload as Msg)
      .filter((p) => p.type === type);
  const lastUserText = (req: LlmRequest): string => {
    const users = req.messages.filter((m) => m.role === "user");
    return (users[users.length - 1] as { text: string }).text;
  };
  const noteCount = (req: LlmRequest): number =>
    req.messages.filter(
      (m) => m.role === "user" && m.text.includes("The caller now speaks"),
    ).length;

  const provider: LlmProvider = {
    id: "openai",
    stream(req) {
      requests.push(structuredClone({ ...req, signal: undefined }));
      return (async function* (): AsyncIterable<LlmStreamEvent> {
        yield { type: "text_delta", text: "Okay." };
        yield {
          type: "done",
          stopReason: "end",
          text: "Okay.",
          toolCalls: [],
        };
      })();
    },
  };

  async function boot(
    sessions: string[] = ["s1"],
    env: Record<string, string> = { SHERPA_LID_AUTO_SWITCH: "1" },
    clearLogs = true,
  ) {
    defineAgent(
      languageSwitchAgent((hooks) =>
        createLlmAgent({
          config: {
            version: 1,
            provider: "openai",
            apiKeySecret: "AGENT_TEST_KEY",
            speech: { coalesceMs: 0 },
          },
          systemPrompt: "You are a test agent.",
          provider,
          env: () => ({ AGENT_TEST_KEY: "secret-value" }),
          hooks,
        }),
      ),
    );
    for (const id of sessions) {
      capture.emit({
        type: "session_start",
        sessionId: id,
        env,
        speakControlAvailable: true,
      });
    }
    await vi.waitFor(() =>
      expect(sent("session_start_ack")).toHaveLength(sessions.length),
    );
    if (clearLogs) capture.send.mockClear();
  }

  const speech = (id: string, event: Msg) =>
    capture.emit({ type: "speech_event", sessionId: id, event });
  const say = (id: string, text: string, extra: Msg = {}) =>
    speech(id, { type: "user_speech_final", text, ...extra });

  it("tells the LLM English before any change, and German exactly once after a committed switch", async () => {
    await boot();
    say("s1", "Hello there");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(lastUserText(requests[0]!)).toContain(
      "The caller now speaks English (en). Reply only in English.",
    );
    expect(noteCount(requests[0]!)).toBe(1);

    speech("s1", {
      type: "voice_language_changed",
      language: "de",
      text: "de",
    });
    await vi.waitFor(() =>
      expect(client("language")).toEqual([
        { type: "language", language: "de" },
      ]),
    );
    say("s1", "Hallo", { replay: true });
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    const second = requests[1]!;
    expect(noteCount(second)).toBe(1);
    expect(lastUserText(second)).toContain(
      "The caller now speaks German (de). Reply only in German.",
    );
    expect(JSON.stringify(second.messages)).not.toContain("English (en)");
  });

  it("a detection alone changes no note but is reported as supported", async () => {
    await boot();
    speech("s1", { type: "user_language", language: "de", text: "de" });
    await vi.waitFor(() =>
      expect(client("language_detected")).toEqual([
        { type: "language_detected", language: "de", supported: true },
      ]),
    );
    say("s1", "Hallo");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(lastUserText(requests[0]!)).toContain("English (en)");
    expect(client("language")).toEqual([]);
  });

  it("an unsupported detection skips the LLM once and speaks the English notice", async () => {
    await boot();
    speech("s1", { type: "user_language", language: "it", text: "it" });
    await vi.waitFor(() =>
      expect(client("language_detected")).toEqual([
        { type: "language_detected", language: "it", supported: false },
      ]),
    );
    say("s1", "garbled transcript");
    await vi.waitFor(() => expect(sent("speak")).toHaveLength(1));
    expect(sent("speak")[0]!.text).toBe(
      "I heard Italian. I can talk with you in English, German, Spanish or French.",
    );
    expect(requests).toHaveLength(0);
    // The mark is consumed: the next final goes to the LLM.
    say("s1", "Hello");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
  });

  it("after a switch to German an unsupported language gets the German notice", async () => {
    await boot();
    speech("s1", {
      type: "voice_language_changed",
      language: "de",
      text: "de",
    });
    await vi.waitFor(() => expect(client("language")).toHaveLength(1));
    speech("s1", { type: "user_language", language: "ru", text: "ru" });
    await vi.waitFor(() => expect(client("language_detected")).toHaveLength(1));
    say("s1", "kaputt");
    await vi.waitFor(() => expect(sent("speak")).toHaveLength(1));
    expect(String(sent("speak")[0]!.text)).toMatch(
      /^Ich habe Russisch gehört\./,
    );
    expect(requests).toHaveLength(0);
  });

  it("never swallows a replay final, even with an unsupported mark set", async () => {
    await boot();
    speech("s1", { type: "user_language", language: "it", text: "it" });
    await vi.waitFor(() => expect(client("language_detected")).toHaveLength(1));
    say("s1", "replayed text", { replay: true });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(sent("speak").map((m) => m.text)).toEqual(["Okay."]);
  });

  it("keeps separate languages for two sessions", async () => {
    await boot(["s1", "s2"]);
    speech("s1", {
      type: "voice_language_changed",
      language: "es",
      text: "es",
    });
    await vi.waitFor(() => expect(client("language")).toHaveLength(1));
    say("s1", "Hola");
    say("s2", "Hello");
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    const texts = requests.map(lastUserText);
    expect(texts.some((t) => t.includes("Spanish (es)"))).toBe(true);
    expect(texts.some((t) => t.includes("English (en)"))).toBe(true);
  });

  it("session end drops the entry: a restarted session id is English again", async () => {
    await boot();
    speech("s1", {
      type: "voice_language_changed",
      language: "fr",
      text: "fr",
    });
    await vi.waitFor(() => expect(client("language")).toHaveLength(1));
    capture.emit({ type: "session_end", sessionId: "s1" });
    capture.emit({
      type: "session_start",
      sessionId: "s1",
      env: { SHERPA_LID_AUTO_SWITCH: "1" },
      speakControlAvailable: true,
    });
    await vi.waitFor(() => expect(sent("session_start_ack")).toHaveLength(1));
    say("s1", "Hello");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(lastUserText(requests[0]!)).toContain("English (en)");
  });

  it("logs language_switch.auto_off once when auto-switch is off in env", async () => {
    await boot(["s1"], {}, false);
    const logs = sent().filter((m) =>
      JSON.stringify(m).includes("language_switch.auto_off"),
    );
    expect(logs).toHaveLength(1);
  });
});
