import { describe, expect, it } from "vitest";

import {
  ALLOWED_CHILD_ENV_KEYS,
  type ChildToParentMessage,
  type ParentToChildMessage,
} from "../src/protocol.js";

describe("protocol", () => {
  it("matches runner allowlisted env keys", () => {
    expect(ALLOWED_CHILD_ENV_KEYS).toEqual([
      "SESSION_ID",
      "PROJECT_ID",
      "BUILD_ID",
    ]);
  });

  it("accepts parent session_start shape", () => {
    const message: ParentToChildMessage = {
      type: "session_start",
      sessionId: "peer-1",
      env: { SESSION_ID: "peer-1", PROJECT_ID: "p", BUILD_ID: "b" },
    };
    expect(message.type).toBe("session_start");
  });

  it("accepts speech_event with SDK event payload", () => {
    const message: ParentToChildMessage = {
      type: "speech_event",
      sessionId: "peer-1",
      event: { type: "user_speech_final", text: "hi" },
    };
    expect(message.event.type).toBe("user_speech_final");
  });

  it("accepts child speak and log messages", () => {
    const speak: ChildToParentMessage = {
      type: "speak",
      sessionId: "peer-1",
      text: "Hello",
    };
    const log: ChildToParentMessage = {
      type: "log",
      level: "info",
      message: "trace",
    };
    const error: ChildToParentMessage = {
      type: "agent_error",
      sessionId: "peer-1",
      message: "boom",
    };
    expect(speak.type).toBe("speak");
    expect(log.level).toBe("info");
    expect(error.type).toBe("agent_error");
  });
});
