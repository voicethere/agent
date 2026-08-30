import { describe, expect, it } from "vitest";

import {
  MAX_LIVE_OBJECTS,
  parseRegisterCommand,
  parseUnregisterCommand,
  REGISTER_NACK_REASON_WORLD_FULL,
  resolveRemoveTarget,
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

  it("parseUnregisterCommand accepts click-to-remove payload with objectId", () => {
    expect(parseUnregisterCommand({ type: "remove", objectId: 7 })).toEqual({
      type: "remove",
      objectId: 7,
    });
  });

  it("resolveRemoveTarget uses explicit objectId even without session ownership", () => {
    expect(resolveRemoveTarget(7, undefined)).toEqual({
      ok: true,
      objectId: 7,
    });
    expect(resolveRemoveTarget(7, new Set())).toEqual({
      ok: true,
      objectId: 7,
    });
  });

  it("resolveRemoveTarget falls back to highest owned object", () => {
    expect(resolveRemoveTarget(undefined, new Set([2, 5, 3]))).toEqual({
      ok: true,
      objectId: 5,
    });
  });

  it("resolveRemoveTarget returns not_found when objectId omitted and session owns nothing", () => {
    expect(resolveRemoveTarget(undefined, undefined)).toEqual({
      ok: false,
      reason: UNREGISTER_NACK_REASON_NOT_FOUND,
    });
    expect(resolveRemoveTarget(undefined, new Set())).toEqual({
      ok: false,
      reason: UNREGISTER_NACK_REASON_NOT_FOUND,
    });
  });

  it("exports nack reason constants", () => {
    expect(REGISTER_NACK_REASON_WORLD_FULL).toBe("world_full");
    expect(UNREGISTER_NACK_REASON_NOT_FOUND).toBe("not_found");
  });
});
