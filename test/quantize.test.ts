import { describe, expect, it } from "vitest";

import {
  dequantize,
  dequantizeUnit,
  isQuantizable,
  quantize,
  quantizeUnit,
  quantStep,
} from "../templates/redis-sync/quantize.js";
import { BOARD_MAX, BOARD_MIN } from "../templates/redis-sync/world-layout.js";

describe("quantizer", () => {
  const step = quantStep(BOARD_MIN, BOARD_MAX);

  it("round-trips within half a step over the board", () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let i = 0; i < 5000; i += 1) {
      const v = BOARD_MIN + rand() * (BOARD_MAX - BOARD_MIN);
      const back = dequantize(
        quantize(v, BOARD_MIN, BOARD_MAX),
        BOARD_MIN,
        BOARD_MAX,
      );
      expect(Math.abs(back - v)).toBeLessThanOrEqual(step / 2 + 1e-9);
    }
  });

  it("clamps at both bounds and never produces -32768", () => {
    expect(quantize(BOARD_MIN, BOARD_MIN, BOARD_MAX)).toBe(-32767);
    expect(quantize(BOARD_MAX, BOARD_MIN, BOARD_MAX)).toBe(32767);
    expect(quantize(-1e9, BOARD_MIN, BOARD_MAX)).toBe(-32767);
    expect(quantize(1e9, BOARD_MIN, BOARD_MAX)).toBe(32767);
    expect(dequantize(32767, BOARD_MIN, BOARD_MAX)).toBe(BOARD_MAX);
  });

  it("maps the centre and -0 to 0", () => {
    expect(quantize(0, BOARD_MIN, BOARD_MAX)).toBe(0);
    expect(Object.is(quantize(-0, BOARD_MIN, BOARD_MAX), 0)).toBe(true);
    expect(Object.is(quantizeUnit(-0), 0)).toBe(true);
  });

  it("rejects NaN and infinities before encode", () => {
    for (const bad of [Number.NaN, Infinity, -Infinity]) {
      expect(isQuantizable(bad)).toBe(false);
      expect(() => quantize(bad, BOARD_MIN, BOARD_MAX)).toThrow(RangeError);
      expect(() => quantizeUnit(bad)).toThrow(RangeError);
    }
    expect(isQuantizable(3)).toBe(true);
  });

  it("quantizes unit components with round(v * 32767) and clamps", () => {
    expect(quantizeUnit(1)).toBe(32767);
    expect(quantizeUnit(-1)).toBe(-32767);
    expect(quantizeUnit(5)).toBe(32767);
    expect(quantizeUnit(0.25)).toBe(Math.round(0.25 * 32767));
    expect(Math.abs(dequantizeUnit(quantizeUnit(0.3)) - 0.3)).toBeLessThan(
      1 / 32767,
    );
  });
});
