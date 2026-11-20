/**
 * int16 quantizer shared by the data-sync templates (plan 2026-11-20-sync-template-efficiency).
 *
 * A bounded range [min, max] maps onto [-32767, 32767] (-32768 is never produced), so the
 * step is (max - min) / 65534 and a round trip is off by at most half a step. Values outside
 * the range are clamped. NaN and +-Infinity are not quantizable: callers check
 * {@link isQuantizable} and drop (and count) the pose instead of encoding it.
 *
 * game-sync carries a same-content copy of this file (templates are self-contained
 * workspaces; a test keeps the two copies identical).
 */
export const QUANT_MAX = 32767;
export const QUANT_STEPS = QUANT_MAX * 2;

export function isQuantizable(v: number): boolean {
  return Number.isFinite(v);
}

function assertQuantizable(v: number): void {
  if (!Number.isFinite(v)) {
    throw new RangeError(`cannot quantize non-finite value ${String(v)}`);
  }
}

/** Quantize `v` clamped to [min, max] into an int16 in [-32767, 32767]. */
export function quantize(v: number, min: number, max: number): number {
  assertQuantizable(v);
  const clamped = v < min ? min : v > max ? max : v;
  const q =
    Math.round(((clamped - min) / (max - min)) * QUANT_STEPS) - QUANT_MAX;
  // `+ 0` turns -0 into 0.
  return q + 0;
}

export function dequantize(q: number, min: number, max: number): number {
  return min + ((q + QUANT_MAX) / QUANT_STEPS) * (max - min);
}

/** Quantize a unit component (direction, rotation) in [-1, 1]. */
export function quantizeUnit(v: number): number {
  assertQuantizable(v);
  const clamped = v < -1 ? -1 : v > 1 ? 1 : v;
  return Math.round(clamped * QUANT_MAX) + 0;
}

export function dequantizeUnit(q: number): number {
  return q / QUANT_MAX;
}

/** Size of one quantization step for [min, max]. */
export function quantStep(min: number, max: number): number {
  return (max - min) / QUANT_STEPS;
}
