/**
 * Can an agent reuse one scratch Buffer for every binary frame?
 * (plan 2026-11-20-sync-template-efficiency, chunk 1 step 3)
 *
 * `broadCastBinaryToClients` / `sendBinaryToClient` hand the caller's Buffer to
 * `process.send` without copying (src/runtime.ts asOutboundBuffer). The runner
 * forks the child with `serialization: "advanced"` (runner
 * src/child/start-sandboxed-child.ts), which serializes the message inside the
 * `process.send` call. So the bytes are copied before `send` returns, and the
 * runner bridge and the nwr data channel only ever see the deserialized copy.
 * This test pins that: a scratch mutated right after the send must not change
 * the bytes the parent receives.
 */
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CHILD = fileURLToPath(
  new URL("./fixtures/binary-send-mutate-child.mjs", import.meta.url),
);

describe("binary send over the runner IPC copies synchronously", () => {
  it("bytes received are the bytes at send time, not after a later mutation", async () => {
    const child = fork(CHILD, [], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "advanced",
    });
    const frames: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      child.on("message", (message: { type?: string; data?: unknown }) => {
        if (message.type === "send_binary_to_client") {
          const data = message.data as Uint8Array;
          frames.push(
            Buffer.from(data.buffer, data.byteOffset, data.byteLength),
          );
        }
        if (message.type === "done") resolve();
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (frames.length < 2) reject(new Error(`child exited ${code}`));
      });
    });
    expect(frames).toHaveLength(2);
    expect([...new Set(frames[0]!)]).toEqual([0x11]);
    expect([...new Set(frames[1]!)]).toEqual([0xff]);
  });
});
