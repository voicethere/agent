import { expect, vi } from "vitest";

import { resetAgentIpcStateForTests } from "../../src/runtime.js";
import { installProcessSendMock } from "./process-mock.js";

export type ParentIpc = {
  type?: string;
  sessionId?: string;
  payload?: unknown;
  data?: Buffer;
  channel?: string;
};

export function emitParentMessage(message: unknown): void {
  (process as NodeJS.EventEmitter).emit("message", message);
}

export function installAgentIpc(): {
  send: ReturnType<typeof vi.fn>;
  restore: () => void;
} {
  resetAgentIpcStateForTests();
  return installProcessSendMock();
}

/** Call before dynamically importing a template that `defineAgent`s at load. */
export function silenceAgentIpc(): ReturnType<typeof installProcessSendMock> {
  return installProcessSendMock();
}

export function clearAgentIpc(send: ReturnType<typeof vi.fn>): void {
  resetAgentIpcStateForTests();
  send.mockClear();
}

export function sentMessages(send: ReturnType<typeof vi.fn>): ParentIpc[] {
  return send.mock.calls.map((call) => call[0] as ParentIpc);
}

export function clientPayloads(
  send: ReturnType<typeof vi.fn>,
  sessionId?: string,
): unknown[] {
  return sentMessages(send)
    .filter(
      (message) =>
        message.type === "send_to_client" &&
        (sessionId === undefined || message.sessionId === sessionId),
    )
    .map((message) => message.payload);
}

export function binarySends(
  send: ReturnType<typeof vi.fn>,
  sessionId?: string,
): Buffer[] {
  return sentMessages(send)
    .filter(
      (message) =>
        message.type === "send_binary_to_client" &&
        (sessionId === undefined || message.sessionId === sessionId) &&
        Buffer.isBuffer(message.data),
    )
    .map((message) => message.data as Buffer);
}

export async function startSession(
  send: ReturnType<typeof vi.fn>,
  sessionId: string,
  env: Record<string, string> = {},
): Promise<void> {
  emitParentMessage({
    type: "session_start",
    sessionId,
    env: { SESSION_ID: sessionId, ...env },
  });
  await vi.waitFor(
    () => {
      expect(sentMessages(send)).toContainEqual({
        type: "session_start_ack",
        sessionId,
      });
    },
    { timeout: 5_000 },
  );
}

export async function endSession(sessionId: string): Promise<void> {
  emitParentMessage({ type: "session_end", sessionId });
  await new Promise((resolve) => setImmediate(resolve));
}

export function emitJson(sessionId: string, payload: unknown): void {
  emitParentMessage({
    type: "data_channel_message",
    sessionId,
    payload: JSON.stringify(payload),
  });
}

export function emitBinary(
  sessionId: string,
  data: Buffer,
  channel = "sync",
): void {
  emitParentMessage({
    type: "data_channel_binary",
    sessionId,
    data,
    channel,
  });
}
