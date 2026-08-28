/**
 * game-sync control-plane message parsers and constants (no defineAgent).
 */

export const MAX_LIVE_OBJECTS = 25;

export const REGISTER_NACK_REASON_WORLD_FULL = "world_full" as const;
export const UNREGISTER_NACK_REASON_NOT_FOUND = "not_found" as const;
export const UNREGISTER_NACK_REASON_NOT_OWNER = "not_owner" as const;

export function parseRegisterCommand(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const record = message as { type?: unknown };
  return record.type === "register";
}

export interface UnregisterCommand {
  type: "unregister" | "remove";
  objectId?: number;
}

export function parseUnregisterCommand(
  message: unknown,
): UnregisterCommand | null {
  if (!message || typeof message !== "object") return null;
  const record = message as { type?: unknown; objectId?: unknown };
  if (record.type !== "unregister" && record.type !== "remove") {
    return null;
  }
  if (record.objectId === undefined) {
    return { type: record.type as "unregister" | "remove" };
  }
  if (
    typeof record.objectId !== "number" ||
    !Number.isFinite(record.objectId)
  ) {
    return null;
  }
  return {
    type: record.type as "unregister" | "remove",
    objectId: Math.trunc(record.objectId),
  };
}

export function parseChatCommand(message: unknown): { text: string } | null {
  if (!message || typeof message !== "object") return null;
  const record = message as { type?: unknown; text?: unknown };
  if (record.type !== "chat" || typeof record.text !== "string") return null;
  const text = record.text.trim();
  if (!text) return null;
  return { text };
}
