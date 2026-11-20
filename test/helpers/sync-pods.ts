/**
 * Test-only harness for the data-sync templates (plan 2026-11-20-sync-template-efficiency).
 *
 * Each template keeps its world in module state, so one import is one "pod".
 * Test files `vi.mock("@voicethere/agent", …)` with {@link agentMockFactory}:
 * `defineAgent` hands the handlers to the harness instead of the IPC runtime, and
 * the send helpers feed a byte meter. `vi.resetModules()` + a fresh import gives
 * a second pod with its own module state in the same process.
 */
import type { AgentHandlers } from "../../src/runtime.js";

export type SyncSend = {
  sessionId: string;
  bytes: number;
  kind: "binary" | "json";
  /** Copy of the bytes at send time (binary only). */
  copy?: Buffer;
  /** The JSON payload (json only). */
  payload?: unknown;
};

type MeterState = {
  sends: SyncSend[];
  /** One entry per broadcast call (binary fan-out or JSON loop counted by payload). */
  broadcasts: number;
  pods: AgentHandlers[];
};

const STATE_KEY = Symbol.for("vt.test.syncPods");

export function meterState(): MeterState {
  const holder = globalThis as unknown as Record<symbol, MeterState>;
  holder[STATE_KEY] ??= { sends: [], broadcasts: 0, pods: [] };
  return holder[STATE_KEY]!;
}

export function resetMeter(): void {
  const state = meterState();
  state.sends.length = 0;
  state.broadcasts = 0;
}

function toBuffer(data: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(data)
    ? data
    : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

let lastJsonPayload: unknown;

/** Factory body for `vi.mock("@voicethere/agent", …)`. */
export async function agentMockFactory(
  importOriginal: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const actual = await importOriginal();
  const state = meterState();
  return {
    ...actual,
    agentLog: () => undefined,
    defineAgent: (handlers: AgentHandlers) => {
      state.pods.push(handlers);
      return handlers;
    },
    sendToClient: (sessionId: string, payload: unknown) => {
      if (payload !== lastJsonPayload) {
        state.broadcasts += 1;
        lastJsonPayload = payload;
      }
      state.sends.push({
        sessionId,
        bytes: Buffer.byteLength(JSON.stringify(payload)),
        kind: "json",
        payload,
      });
    },
    sendBinaryToClient: (sessionId: string, data: Buffer | Uint8Array) => {
      const buffer = toBuffer(data);
      state.sends.push({
        sessionId,
        bytes: buffer.byteLength,
        kind: "binary",
        copy: Buffer.from(buffer),
      });
    },
    broadCastBinaryToClients: (
      data: Buffer | Uint8Array,
      sessionIds: readonly string[],
    ) => {
      const buffer = toBuffer(data);
      state.broadcasts += 1;
      for (const sessionId of sessionIds) {
        state.sends.push({
          sessionId,
          bytes: buffer.byteLength,
          kind: "binary",
          // The scratch buffer is reused: capture the content at send time.
          copy: Buffer.from(buffer),
        });
      }
    },
  };
}

/** Bytes per session over the metered window, as B/s for `windowMs`. */
export function bytesPerSessionPerSecond(
  windowMs: number,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const send of meterState().sends) {
    totals.set(send.sessionId, (totals.get(send.sessionId) ?? 0) + send.bytes);
  }
  for (const [sessionId, bytes] of totals) {
    totals.set(sessionId, (bytes * 1000) / windowMs);
  }
  return totals;
}

export type MeterSummary = {
  sessions: number;
  frames: number;
  frameBytes: number[];
  perSessionBps: number;
  totalBps: number;
};

export function summarizeMeter(windowMs: number): MeterSummary {
  const perSession = bytesPerSessionPerSecond(windowMs);
  const values = [...perSession.values()];
  const total = values.reduce((sum, value) => sum + value, 0);
  const frameBytes = [
    ...new Set(meterState().sends.map((send) => send.bytes)),
  ].sort((a, b) => a - b);
  return {
    sessions: perSession.size,
    frames: meterState().sends.length,
    frameBytes,
    perSessionBps: values.length === 0 ? 0 : total / values.length,
    totalBps: total,
  };
}

/** Import a template as a fresh pod; returns its handlers. */
export async function loadPod(
  importer: () => Promise<unknown>,
  resetModules: () => void,
): Promise<AgentHandlers> {
  const state = meterState();
  const before = state.pods.length;
  resetModules();
  await importer();
  if (state.pods.length !== before + 1) {
    throw new Error(
      `template import registered ${state.pods.length - before} handler sets, want 1`,
    );
  }
  return state.pods[state.pods.length - 1]!;
}
