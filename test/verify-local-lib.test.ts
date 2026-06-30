import { describe, expect, it } from "vitest";

import type { ChildToParentMessage } from "../src/protocol.js";
import {
  VERIFY_CALLBACK_KEYS,
  DEFAULT_VERIFY_BUNDLE,
  VERIFY_SESSION_ID,
  detectVerifyCallbacks,
  hasDefineAgentRegistration,
  parseBundleArg,
  waitForSpeak,
} from "../src/verify/lib.js";

describe("parseBundleArg", () => {
  const cwd = "/workspace/agent";

  it("defaults to dist/agent.js under cwd", () => {
    expect(parseBundleArg([], {}, cwd)).toBe(`${cwd}/dist/agent.js`);
    expect(DEFAULT_VERIFY_BUNDLE).toBe("dist/agent.js");
  });

  it("uses --bundle flag when present", () => {
    expect(parseBundleArg(["--bundle", "./custom.js"], {}, cwd)).toBe(
      `${cwd}/custom.js`,
    );
    expect(parseBundleArg(["-b", "./short.js"], {}, cwd)).toBe(
      `${cwd}/short.js`,
    );
  });

  it("prefers --bundle over AGENT_BUNDLE_PATH", () => {
    expect(
      parseBundleArg(
        ["--bundle", "./from-flag.js"],
        { AGENT_BUNDLE_PATH: "./from-env.js" },
        cwd,
      ),
    ).toBe(`${cwd}/from-flag.js`);
  });

  it("uses AGENT_BUNDLE_PATH when --bundle is absent", () => {
    expect(
      parseBundleArg([], { AGENT_BUNDLE_PATH: "./from-env.js" }, cwd),
    ).toBe(`${cwd}/from-env.js`);
  });
});

describe("waitForSpeak", () => {
  it("resolves when a matching speak message appears", async () => {
    const messages: ChildToParentMessage[] = [];
    const promise = waitForSpeak(messages, VERIFY_SESSION_ID, 1000);

    setTimeout(() => {
      messages.push({
        type: "speak",
        sessionId: VERIFY_SESSION_ID,
        text: "hello",
      });
    }, 100);

    const speak = await promise;
    expect(speak.text).toBe("hello");
  });

  it("rejects on timeout when no speak arrives", async () => {
    await expect(waitForSpeak([], VERIFY_SESSION_ID, 150)).rejects.toThrow(
      /Timed out/,
    );
  });

  it("ignores speak messages for other session ids", async () => {
    const messages: ChildToParentMessage[] = [
      { type: "speak", sessionId: "other-peer", text: "nope" },
    ];
    await expect(
      waitForSpeak(messages, VERIFY_SESSION_ID, 150),
    ).rejects.toThrow(/Timed out/);
  });
});

describe("detectVerifyCallbacks", () => {
  it("detects callback keys from object literal forms", () => {
    const source = `
      defineAgent({
        onSpeechEvent: async () => {},
        onDataChannelBinary(ctx) {},
      });
    `;
    expect(detectVerifyCallbacks(source)).toEqual([
      "onSpeechEvent",
      "onDataChannelBinary",
    ]);
  });

  it("returns empty list when none of the verification callbacks are present", () => {
    const source = "defineAgent({ onSessionStart: () => {} });";
    expect(detectVerifyCallbacks(source)).toEqual([]);
    expect(VERIFY_CALLBACK_KEYS.length).toBeGreaterThan(0);
  });
});

describe("hasDefineAgentRegistration", () => {
  it("detects defineAgent call in bundle source", () => {
    expect(
      hasDefineAgentRegistration("import { defineAgent } from '@voicethere/agent'; defineAgent({ onSpeechEvent() {} });"),
    ).toBe(true);
  });

  it("returns false when defineAgent is absent", () => {
    expect(hasDefineAgentRegistration("process.on('message', () => {});")).toBe(
      false,
    );
  });
});
