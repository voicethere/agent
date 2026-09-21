import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetAgentIpcStateForTests, speakAndChat } from "../src/runtime.js";
import { installProcessSendMock } from "./helpers/process-mock.js";

describe("speakAndChat", () => {
  let sendMock: ReturnType<typeof installProcessSendMock>;

  beforeEach(() => {
    resetAgentIpcStateForTests();
  });

  afterEach(() => {
    sendMock?.restore();
  });

  function ipcCalls(): unknown[] {
    return sendMock.send.mock.calls.map((call) => call[0]);
  }

  it("sends chat_reply before speak IPC", () => {
    sendMock = installProcessSendMock();
    speakAndChat("peer-1", "Hello there");
    expect(ipcCalls()).toEqual([
      {
        type: "send_to_client",
        sessionId: "peer-1",
        payload: { type: "chat_reply", text: "Hello there" },
      },
      { type: "speak", sessionId: "peer-1", text: "Hello there" },
    ]);
  });

  it("includes stream and utteranceId when stream is true", () => {
    sendMock = installProcessSendMock();
    speakAndChat("peer-1", "Hi", {
      stream: true,
      utteranceId: "utt-fixed",
    });
    const send = ipcCalls()[0] as {
      payload: { stream?: boolean; utteranceId?: string };
    };
    expect(send.payload).toMatchObject({
      type: "chat_reply",
      text: "Hi",
      stream: true,
      utteranceId: "utt-fixed",
    });
    expect(ipcCalls()[1]).toMatchObject({ type: "speak", text: "Hi" });
  });

  it("generates utteranceId when stream is true and id omitted", () => {
    sendMock = installProcessSendMock();
    speakAndChat("peer-1", "Hi", { stream: true });
    const send = ipcCalls()[0] as {
      payload: { stream?: boolean; utteranceId?: string };
    };
    expect(send.payload.stream).toBe(true);
    expect(send.payload.utteranceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(send.payload).not.toHaveProperty("stream", false);
  });

  it("omits stream field when stream is false or omitted", () => {
    sendMock = installProcessSendMock();
    speakAndChat("peer-1", "Plain", { stream: false });
    const payload = (ipcCalls()[0] as { payload: Record<string, unknown> })
      .payload;
    expect(payload).toEqual({ type: "chat_reply", text: "Plain" });
    expect(payload).not.toHaveProperty("stream");
    expect(payload).not.toHaveProperty("utteranceId");
  });

  it("does not send IPC for empty or whitespace-only text", () => {
    sendMock = installProcessSendMock();
    speakAndChat("peer-1", "");
    speakAndChat("peer-1", "   \n");
    expect(sendMock.send).not.toHaveBeenCalled();
  });
});
