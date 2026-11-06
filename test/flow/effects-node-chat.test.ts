import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createNodeEffects } from "../../src/flow/effects-node.js";
import {
  SESSION_START_INIT_DELAY_ENABLED_ENV,
  defineAgent,
  resetAgentIpcStateForTests,
} from "../../src/runtime.js";
import { installProcessMessageCapture } from "../helpers/process-mock.js";

type Msg = Record<string, unknown>;

const SESSION = "peer-chat";

describe("createNodeEffects chat turnId", () => {
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

  async function start(record: boolean) {
    defineAgent({});
    capture.emit({
      type: "session_start",
      sessionId: SESSION,
      env: { SESSION_ID: SESSION },
      speakControlAvailable: true,
      ...(record ? { chatReplyRecordAvailable: true } : {}),
    });
    await vi.waitFor(() => expect(sent("session_start_ack")).toHaveLength(1));
    return createNodeEffects({
      sessionId: SESSION,
      env: {},
      providerFor: () => {
        throw new Error("unused");
      },
      log: () => {},
    });
  }

  const sent = (type: string): Msg[] =>
    capture.send.mock.calls
      .map((c) => c[0] as Msg)
      .filter((m) => m.type === type);
  const replies = (): Msg[] =>
    sent("send_to_client")
      .map((m) => m.payload as Msg)
      .filter((p) => p.type === "chat_reply");

  it("chat_reply carries the turnId passed to record_reply, per turn", async () => {
    const fx = await start(true);
    fx.chat?.("one", { turnId: `${SESSION}:1` });
    fx.chat?.("two", { turnId: `${SESSION}:5` });
    const r = replies();
    expect(r.map((p) => p.turnId)).toEqual([`${SESSION}:1`, `${SESSION}:5`]);
    expect(sent("record_reply").map((m) => m.turnId)).toEqual(
      r.map((p) => p.turnId),
    );
  });

  it("chat_reply carries the turnId passed to speak on the fallback path", async () => {
    const fx = await start(false);
    fx.chat?.("one", { turnId: `${SESSION}:1` });
    fx.chat?.("two", { turnId: `${SESSION}:5` });
    expect(replies().map((p) => p.turnId)).toEqual([
      `${SESSION}:1`,
      `${SESSION}:5`,
    ]);
    expect(sent("speak").map((m) => m.turnId)).toEqual([
      `${SESSION}:1`,
      `${SESSION}:5`,
    ]);
  });

  it("a chat without a turnId sends no turnId key", async () => {
    const fx = await start(true);
    fx.chat?.("one");
    expect(replies()).toEqual([{ type: "chat_reply", text: "one" }]);
  });
});
