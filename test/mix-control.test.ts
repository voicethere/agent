import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MIX_REQUIRES_VOICE_PLUS_DATA,
  type ChildToParentMessage,
  type ParentToChildMessage,
} from "../src/protocol.js";
import {
  addClientToMix,
  clearTtsPose,
  createMixGroup,
  defineAgent,
  removeClientFromMix,
  resetAgentIpcStateForTests,
  setClientPose,
  setDefaultMixPlacement,
  setPositionalMixing,
  setSttEnabled,
  setTtsMixPlacement,
  setTtsPose,
} from "../src/runtime.js";
import { installProcessMessageCapture } from "./helpers/process-mock.js";

async function startMixSession(
  capture: ReturnType<typeof installProcessMessageCapture>,
  options?: { mixAvailable?: boolean },
): Promise<void> {
  capture.emit({
    type: "session_start",
    sessionId: "peer-1",
    env: { SESSION_ID: "peer-1" },
    mixAvailable: options?.mixAvailable ?? true,
  });
  await vi.waitFor(() =>
    expect(capture.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session_start_ack" }),
    ),
  );
  capture.send.mockClear();
}

function emitMixAck(
  capture: ReturnType<typeof installProcessMessageCapture>,
  sent: { requestId: string; action: string },
): void {
  capture.emit({
    type: "mix_control_ack",
    action: sent.action,
    requestId: sent.requestId,
    ok: true,
    reason: "applied",
  });
}

describe("protocol mix and STT IPC shapes", () => {
  it("accepts parent mix_control_ack and stt_control_ack shapes", () => {
    const mixAck: ParentToChildMessage = {
      type: "mix_control_ack",
      action: "create_group",
      requestId: "req-mix",
      ok: true,
      reason: "applied",
    };
    const sttAck: ParentToChildMessage = {
      type: "stt_control_ack",
      requestId: "req-stt",
      ok: true,
      reason: "applied",
    };
    expect(mixAck.ok).toBe(true);
    expect(sttAck.ok).toBe(true);
  });

  it("accepts child mix_control and stt_control messages", () => {
    const mix: ChildToParentMessage = {
      type: "mix_control",
      action: "set_pose",
      requestId: "req-1",
      clientId: "peer-a",
      pose: {
        position: { x: 0, y: 0, z: 0 },
        orientation: { x: 0, y: 0, z: 0, w: 1 },
      },
    };
    const sttAll: ChildToParentMessage = {
      type: "stt_control",
      requestId: "req-2",
      enabled: false,
    };
    const sttOne: ChildToParentMessage = {
      type: "stt_control",
      requestId: "req-3",
      enabled: true,
      clientId: "peer-a",
    };
    expect(mix.action).toBe("set_pose");
    expect(sttAll.enabled).toBe(false);
    expect(sttOne.clientId).toBe("peer-a");
  });

  it("accepts session_start with mixAvailable", () => {
    const message: ParentToChildMessage = {
      type: "session_start",
      sessionId: "peer-1",
      env: { SESSION_ID: "peer-1" },
      mixAvailable: true,
    };
    expect(message.mixAvailable).toBe(true);
  });
});

describe("mix control", () => {
  const childBundleEnv = process.env.__CHILD_BUNDLE_PATH__;

  beforeEach(() => {
    resetAgentIpcStateForTests();
    delete process.env.__CHILD_BUNDLE_PATH__;
  });

  afterEach(() => {
    if (childBundleEnv === undefined) {
      delete process.env.__CHILD_BUNDLE_PATH__;
    } else {
      process.env.__CHILD_BUNDLE_PATH__ = childBundleEnv;
    }
  });

  it("resolves local_mock when not a forked agent child", async () => {
    const capture = installProcessMessageCapture();
    defineAgent({});
    await startMixSession(capture);

    const result = await createMixGroup({ id: "g1", clientIds: ["peer-1"] });
    expect(result).toMatchObject({ ok: true, reason: "local_mock" });
    expect(capture.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "mix_control" }),
    );
    capture.restore();
  });

  it("sends mix_control IPC and awaits matching ack on Voice+Data session", async () => {
    process.env.__CHILD_BUNDLE_PATH__ = "/tmp/agent.js";
    const capture = installProcessMessageCapture();
    defineAgent({});
    await startMixSession(capture, { mixAvailable: true });

    const ackPromise = createMixGroup({
      id: "proximity",
      clientIds: ["a", "b"],
    });
    await vi.waitFor(() => expect(capture.send).toHaveBeenCalled());
    const sent = capture.send.mock.calls[0]?.[0] as {
      type: string;
      action: string;
      requestId: string;
      groupId: string;
      clientIds: string[];
    };
    expect(sent).toEqual(
      expect.objectContaining({
        type: "mix_control",
        action: "create_group",
        groupId: "proximity",
        clientIds: ["a", "b"],
      }),
    );

    emitMixAck(capture, sent);
    await expect(ackPromise).resolves.toEqual({
      ok: true,
      reason: "applied",
      requestId: sent.requestId,
    });
    capture.restore();
  });

  it("sends IPC for addClientToMix, setPositionalMixing, placements, and setClientPose", async () => {
    process.env.__CHILD_BUNDLE_PATH__ = "/tmp/agent.js";
    const capture = installProcessMessageCapture();
    defineAgent({});
    await startMixSession(capture, { mixAvailable: true });

    const pose = {
      position: { x: 1, y: 2, z: 3 },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
    };

    const calls: Array<() => Promise<unknown>> = [
      () => addClientToMix("g1", "peer-2"),
      () => removeClientFromMix("g1", "peer-2"),
      () => setPositionalMixing(true),
      () => setDefaultMixPlacement("left"),
      () => setTtsMixPlacement("right"),
      () => setClientPose("peer-2", pose),
      () => setTtsPose("peer-2", pose),
      () => clearTtsPose("peer-2"),
    ];

    const expectedActions = [
      "add_client",
      "remove_client",
      "set_positional",
      "set_default_placement",
      "set_tts_placement",
      "set_pose",
      "set_tts_pose",
      "clear_tts_pose",
    ];

    for (let i = 0; i < calls.length; i++) {
      const promise = calls[i]!();
      await vi.waitFor(() => expect(capture.send).toHaveBeenCalled());
      const sent = capture.send.mock.calls.at(-1)?.[0] as {
        type: string;
        action: string;
        requestId: string;
      };
      expect(sent.type).toBe("mix_control");
      expect(sent.action).toBe(expectedActions[i]);
      emitMixAck(capture, sent);
      await promise;
      capture.send.mockClear();
    }

    capture.restore();
  });

  it("throws when mixAvailable is false (voice-only)", async () => {
    process.env.__CHILD_BUNDLE_PATH__ = "/tmp/agent.js";
    const capture = installProcessMessageCapture();
    defineAgent({});
    await startMixSession(capture, { mixAvailable: false });

    await expect(
      createMixGroup({ id: "g1", clientIds: ["peer-1"] }),
    ).rejects.toThrow(MIX_REQUIRES_VOICE_PLUS_DATA);
    expect(capture.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "mix_control" }),
    );
    capture.restore();
  });

  it("throws when mixAvailable is omitted (older runner / data-only)", async () => {
    const capture = installProcessMessageCapture();
    defineAgent({});

    capture.emit({
      type: "session_start",
      sessionId: "peer-1",
      env: { SESSION_ID: "peer-1" },
    });
    await vi.waitFor(() =>
      expect(capture.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "session_start_ack" }),
      ),
    );
    capture.send.mockClear();

    await expect(setPositionalMixing(true)).rejects.toThrow(
      MIX_REQUIRES_VOICE_PLUS_DATA,
    );
    capture.restore();
  });

  it("throws when no session has mixAvailable", async () => {
    await expect(
      createMixGroup({ id: "g1", clientIds: ["peer-1"] }),
    ).rejects.toThrow(MIX_REQUIRES_VOICE_PLUS_DATA);
  });
});

describe("stt control", () => {
  const childBundleEnv = process.env.__CHILD_BUNDLE_PATH__;

  beforeEach(() => {
    resetAgentIpcStateForTests();
    delete process.env.__CHILD_BUNDLE_PATH__;
  });

  afterEach(() => {
    if (childBundleEnv === undefined) {
      delete process.env.__CHILD_BUNDLE_PATH__;
    } else {
      process.env.__CHILD_BUNDLE_PATH__ = childBundleEnv;
    }
  });

  it("resolves local_mock when not a forked agent child", async () => {
    const result = await setSttEnabled({ enabled: false });
    expect(result).toMatchObject({ ok: true, reason: "local_mock" });
  });

  it("sends stt_control for all clients when clientId is omitted", async () => {
    process.env.__CHILD_BUNDLE_PATH__ = "/tmp/agent.js";
    const capture = installProcessMessageCapture();
    defineAgent({});

    const ackPromise = setSttEnabled({ enabled: false });
    await vi.waitFor(() => expect(capture.send).toHaveBeenCalled());
    const sent = capture.send.mock.calls[0]?.[0] as {
      type: string;
      enabled: boolean;
      requestId: string;
      clientId?: string;
    };
    expect(sent).toEqual(
      expect.objectContaining({
        type: "stt_control",
        enabled: false,
      }),
    );
    expect(sent.clientId).toBeUndefined();

    capture.emit({
      type: "stt_control_ack",
      requestId: sent.requestId,
      ok: true,
      reason: "applied",
    });
    await expect(ackPromise).resolves.toEqual({
      ok: true,
      reason: "applied",
      requestId: sent.requestId,
    });
    capture.restore();
  });

  it("sends stt_control with clientId for one client", async () => {
    process.env.__CHILD_BUNDLE_PATH__ = "/tmp/agent.js";
    const capture = installProcessMessageCapture();
    defineAgent({});

    const ackPromise = setSttEnabled({
      enabled: true,
      clientId: "peer-a",
      sessionId: "peer-a",
    });
    await vi.waitFor(() => expect(capture.send).toHaveBeenCalled());
    const sent = capture.send.mock.calls[0]?.[0] as {
      type: string;
      enabled: boolean;
      clientId: string;
      sessionId: string;
      requestId: string;
    };
    expect(sent).toEqual(
      expect.objectContaining({
        type: "stt_control",
        enabled: true,
        clientId: "peer-a",
        sessionId: "peer-a",
      }),
    );

    capture.emit({
      type: "stt_control_ack",
      requestId: sent.requestId,
      ok: true,
      reason: "applied",
    });
    await ackPromise;
    capture.restore();
  });

  it("allows STT control on voice-only session (mixAvailable false)", async () => {
    process.env.__CHILD_BUNDLE_PATH__ = "/tmp/agent.js";
    const capture = installProcessMessageCapture();
    defineAgent({});
    await startMixSession(capture, { mixAvailable: false });

    const ackPromise = setSttEnabled({ enabled: false, clientId: "peer-1" });
    await vi.waitFor(() => expect(capture.send).toHaveBeenCalled());
    const sent = capture.send.mock.calls[0]?.[0] as {
      type: string;
      requestId: string;
    };
    expect(sent.type).toBe("stt_control");
    capture.emit({
      type: "stt_control_ack",
      requestId: sent.requestId,
      ok: true,
      reason: "applied",
    });
    await expect(ackPromise).resolves.toMatchObject({ ok: true });
    capture.restore();
  });
});
