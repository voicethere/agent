import { vi } from "vitest";

type ProcessMessageListener = (message: unknown) => void;

export function installProcessMessageCapture(): {
  emit: (message: unknown) => void;
  restore: () => void;
} {
  const listeners = new Set<ProcessMessageListener>();
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
    restore: () => {
      spy.mockRestore();
      listeners.clear();
    },
  };
}

export function installProcessSendMock(): {
  send: ReturnType<typeof vi.fn>;
  restore: () => void;
} {
  const send = vi.fn();
  const original = process.send;
  process.send = send as typeof process.send;

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
