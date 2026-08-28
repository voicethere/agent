import { describe, expect, it } from "vitest";

import {
  MAX_LIVE_OBJECTS,
  parseRegisterCommand,
  parseUnregisterCommand,
  REGISTER_NACK_REASON_WORLD_FULL,
  UNREGISTER_NACK_REASON_NOT_FOUND,
} from "../templates/game-sync-protocol.js";

describe("game-sync-protocol", () => {
  it("exports MAX_LIVE_OBJECTS = 25", () => {
    expect(MAX_LIVE_OBJECTS).toBe(25);
  });

  it("parseRegisterCommand accepts register", () => {
    expect(parseRegisterCommand({ type: "register" })).toBe(true);
    expect(parseRegisterCommand({ type: "chat" })).toBe(false);
    expect(parseRegisterCommand(null)).toBe(false);
  });

  it("parseUnregisterCommand accepts unregister and remove", () => {
    expect(parseUnregisterCommand({ type: "unregister" })).toEqual({
      type: "unregister",
    });
    expect(parseUnregisterCommand({ type: "remove", objectId: 3 })).toEqual({
      type: "remove",
      objectId: 3,
    });
    expect(parseUnregisterCommand({ type: "register" })).toBeNull();
    expect(
      parseUnregisterCommand({ type: "remove", objectId: "x" }),
    ).toBeNull();
  });

  it("exports nack reason constants", () => {
    expect(REGISTER_NACK_REASON_WORLD_FULL).toBe("world_full");
    expect(UNREGISTER_NACK_REASON_NOT_FOUND).toBe("not_found");
  });
});
