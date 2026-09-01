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
      "IDLE_TIMEOUT_SEC",
      "AGENT_CUSTOMER_CONTEXT",
    ]);
  });

  it("accepts parent session_start shape with recordingAvailable", () => {
    const message: ParentToChildMessage = {
      type: "session_start",
      sessionId: "peer-1",
      env: { SESSION_ID: "peer-1", PROJECT_ID: "p", BUILD_ID: "b" },
      recordingAvailable: true,
      mixAvailable: true,
    };
    expect(message.type).toBe("session_start");
    expect(message.recordingAvailable).toBe(true);
    expect(message.mixAvailable).toBe(true);
  });

  it("accepts parent recording_control_ack shape", () => {
    const message: ParentToChildMessage = {
      type: "recording_control_ack",
      sessionId: "peer-1",
      action: "start",
      requestId: "req-1",
      ok: true,
      reason: "applied",
    };
    expect(message.ok).toBe(true);
    expect(message.reason).toBe("applied");
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
    const recording: ChildToParentMessage = {
      type: "recording_control",
      sessionId: "peer-1",
      action: "start",
      requestId: "req-abc",
    };
    const binary: ChildToParentMessage = {
      type: "send_binary_to_client",
      sessionId: "peer-1",
      data: Buffer.from([1, 2, 3]),
      channel: "sync",
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
    expect(recording.action).toBe("start");
    expect(binary.channel).toBe("sync");
    expect(log.level).toBe("info");
    expect(error.type).toBe("agent_error");
  });

  it("accepts parent data_channel_binary shape", () => {
    const message: ParentToChildMessage = {
      type: "data_channel_binary",
      sessionId: "peer-1",
      data: Buffer.from([0xde, 0xad]),
      channel: "control",
    };
    expect(message.data.length).toBe(2);
  });

  it("accepts parent webhook shape with raw body bytes", () => {
    const body = Buffer.from('{"event":"test"}');
    const message: ParentToChildMessage = {
      type: "webhook",
      eventId: "evt-abc",
      projectId: "proj-1",
      method: "POST",
      path: "/custom",
      headers: { "x-test": "1" },
      body,
      contentType: "application/json",
      receivedAt: "2026-08-25T00:00:00.000Z",
    };
    expect(message.type).toBe("webhook");
    expect(message.body.equals(body)).toBe(true);
  });
});
