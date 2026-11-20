import { vi } from "vitest";

type ProcessMessageListener = (message: unknown) => void;

export function installProcessMessageCapture(): {
  emit: (message: unknown) => void;
  send: ReturnType<typeof vi.fn>;
  restore: () => void;
} {
  const listeners = new Set<ProcessMessageListener>();
  const sendStub = installProcessSendMock();
  const originalOn = process.on.bind(process);
  const spy = vi.spyOn(process, "on").mockImplementation(((
    event: string | symbol,
    listener: ProcessMessageListener,
  ) => {
    if (event === "message") {
      listeners.add(listener);
      return process;
    }
    return originalOn(event, listener);
  }) as typeof process.on);

  return {
    emit: (message) => {
      for (const listener of listeners) {
        listener(message);
      }
    },
    send: sendStub.send,
    restore: () => {
      spy.mockRestore();
      listeners.clear();
      sendStub.restore();
    },
  };
}

export function installProcessSendMock(
  options: { copyBinary?: boolean } = {},
): {
  send: ReturnType<typeof vi.fn>;
  restore: () => void;
} {
  const send = vi.fn();
  const original = process.send;
  // copyBinary: advanced IPC serialization copies binary payloads inside process.send
  // (test/binary-send-copy.test.ts), so agents may reuse one scratch buffer. Record the
  // same copy, not the caller's live buffer. Off by default: runtime tests assert identity.
  process.send = ((message: unknown, ...rest: unknown[]) => {
    const data = (message as { data?: unknown } | null)?.data;
    const recorded =
      options.copyBinary && Buffer.isBuffer(data)
        ? { ...(message as object), data: Buffer.from(data) }
        : message;
    return send(recorded, ...rest);
  }) as typeof process.send;

  return {
    send,
    restore: () => {
      if (original === undefined) {
        delete (process as { send?: typeof process.send }).send;
      } else {
        process.send = original;
      }
    },
  };
}
