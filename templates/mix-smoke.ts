/**
 * E2E agent for voice-data-mix-smoke — positional mix via data-channel commands.
 *
 * Protocol (JSON on control DC):
 * - `{ type: "mix", action: "whoami" }`
 * - `{ type: "mix", action: "create_group", groupId, clientIds }`
 * - `{ type: "mix", action: "set_pose", clientId, pose }`
 * - `{ type: "mix", action: "set_positional", enabled }`
 * - `{ type: "mix", action: "list_clients" }` (optional)
 *
 * Acks: `{ type: "mix_ack", action, ok: true, ... }` or `{ ok: false, error }`.
 * Ignores `ping` / chat strings (voice-control readiness). No TTS during smoke.
 */
import {
  MIX_REQUIRES_VOICE_PLUS_DATA,
  createMixGroup,
  defineAgent,
  sendToClient,
  setClientPose,
  setPositionalMixing,
} from "@voicethere/agent";

/** E2E fixture marker — rewritten before each fixture upload when needed. */
export const FIXTURE_MARKER = "mix-smoke-fixture-a";

export type MixPose = {
  position: { x: number; y: number; z: number };
  orientation: { x: number; y: number; z: number; w: number };
};

export type MixCommand =
  | { type: "mix"; action: "whoami" }
  | {
      type: "mix";
      action: "create_group";
      groupId: string;
      clientIds: string[];
    }
  | { type: "mix"; action: "set_pose"; clientId: string; pose: MixPose }
  | { type: "mix"; action: "set_positional"; enabled: boolean }
  | { type: "mix"; action: "list_clients" };

export type MixAck =
  | {
      type: "mix_ack";
      action: string;
      ok: true;
      sessionId?: string;
      clientIds?: string[];
    }
  | { type: "mix_ack"; action: string; ok: false; error: string };

const connectedSessions = new Set<string>();
let mixAvailableForChild = false;

export function isMixCommand(message: unknown): message is MixCommand {
  if (!message || typeof message !== "object") return false;
  const record = message as { type?: unknown; action?: unknown };
  if (record.type !== "mix" || typeof record.action !== "string") {
    return false;
  }
  switch (record.action) {
    case "whoami":
    case "list_clients":
      return true;
    case "create_group": {
      const group = message as {
        groupId?: unknown;
        clientIds?: unknown;
      };
      return (
        typeof group.groupId === "string" &&
        group.groupId.trim().length > 0 &&
        Array.isArray(group.clientIds) &&
        group.clientIds.every((id) => typeof id === "string")
      );
    }
    case "set_pose": {
      const poseMsg = message as { clientId?: unknown; pose?: unknown };
      return (
        typeof poseMsg.clientId === "string" &&
        poseMsg.clientId.trim().length > 0 &&
        isMixPose(poseMsg.pose)
      );
    }
    case "set_positional": {
      const positional = message as { enabled?: unknown };
      return typeof positional.enabled === "boolean";
    }
    default:
      return false;
  }
}

export function isMixPose(value: unknown): value is MixPose {
  if (!value || typeof value !== "object") return false;
  const pose = value as MixPose;
  return isVec3(pose.position) && isQuat(pose.orientation);
}

function isVec3(value: unknown): value is { x: number; y: number; z: number } {
  if (!value || typeof value !== "object") return false;
  const v = value as { x?: unknown; y?: unknown; z?: unknown };
  return (
    typeof v.x === "number" &&
    typeof v.y === "number" &&
    typeof v.z === "number"
  );
}

function isQuat(
  value: unknown,
): value is { x: number; y: number; z: number; w: number } {
  if (!value || typeof value !== "object") return false;
  const q = value as { x?: unknown; y?: unknown; z?: unknown; w?: unknown };
  return (
    typeof q.x === "number" &&
    typeof q.y === "number" &&
    typeof q.z === "number" &&
    typeof q.w === "number"
  );
}

function ackOk(
  sessionId: string,
  action: string,
  extra?: { sessionId?: string; clientIds?: string[] },
): void {
  sendToClient(sessionId, {
    type: "mix_ack",
    action,
    ok: true,
    ...extra,
  } satisfies MixAck);
}

function ackError(sessionId: string, action: string, error: string): void {
  sendToClient(sessionId, {
    type: "mix_ack",
    action,
    ok: false,
    error,
  } satisfies MixAck);
}

function requireMix(sessionId: string, action: string): boolean {
  if (mixAvailableForChild) {
    return true;
  }
  ackError(sessionId, action, MIX_REQUIRES_VOICE_PLUS_DATA);
  return false;
}

async function handleMixCommand(
  sessionId: string,
  command: MixCommand,
): Promise<void> {
  const { action } = command;

  switch (action) {
    case "whoami":
      ackOk(sessionId, action, { sessionId });
      return;
    case "list_clients":
      ackOk(sessionId, action, {
        clientIds: [...connectedSessions],
      });
      return;
    case "create_group": {
      if (!requireMix(sessionId, action)) return;
      const result = await createMixGroup({
        id: command.groupId,
        clientIds: command.clientIds,
      });
      if (!result.ok) {
        ackError(sessionId, action, result.reason ?? "create_group failed");
        return;
      }
      ackOk(sessionId, action);
      return;
    }
    case "set_pose": {
      if (!requireMix(sessionId, action)) return;
      const result = await setClientPose(command.clientId, command.pose);
      if (!result.ok) {
        ackError(sessionId, action, result.reason ?? "set_pose failed");
        return;
      }
      ackOk(sessionId, action);
      return;
    }
    case "set_positional": {
      if (!requireMix(sessionId, action)) return;
      const result = await setPositionalMixing(command.enabled);
      if (!result.ok) {
        ackError(sessionId, action, result.reason ?? "set_positional failed");
        return;
      }
      ackOk(sessionId, action);
      return;
    }
    default:
      ackError(sessionId, "unknown", "unsupported mix action");
  }
}

defineAgent({
  onClientJoin(ctx) {
    mixAvailableForChild = ctx.mixAvailable;
    connectedSessions.add(ctx.sessionId);
  },

  onClientLeave({ sessionId }) {
    connectedSessions.delete(sessionId);
  },

  onDataChannelMessage(ctx) {
    if (isMixCommand(ctx.message)) {
      void handleMixCommand(ctx.sessionId, ctx.message);
      return;
    }
    // Ignore ping / chat — voice-control readiness only.
  },
});
