/** Inline orbit sine clip — 16 kHz mono s16le, decoded size under 64 KiB play cap. */

/** 2 s keeps loop-restart gaps infrequent; 16 kHz mono still fits under 64 KiB. */
export const ORBIT_SINE_DURATION_MS = 2000;
export const ORBIT_SINE_FREQUENCY_HZ = 440;
export const ORBIT_SINE_AMPLITUDE = 8000;
export const ORBIT_SINE_SAMPLE_RATE = 16_000;
export const ORBIT_SINE_INLINE_URL =
  "https://example.com/inline-orbit-sine.wav";

/** Snap duration to an integer number of cycles so the clip loops at a zero crossing. */
export function orbitSineSampleCount(
  durationMs = ORBIT_SINE_DURATION_MS,
  frequencyHz = ORBIT_SINE_FREQUENCY_HZ,
  sampleRate = ORBIT_SINE_SAMPLE_RATE,
): number {
  const targetCycles = (durationMs / 1000) * frequencyHz;
  const cycles = Math.max(1, Math.floor(targetCycles));
  return Math.round((cycles * sampleRate) / frequencyHz);
}

/** Duration in ms for a clip built with {@link orbitSineSampleCount}. */
export function orbitSineClipDurationMs(
  durationMs = ORBIT_SINE_DURATION_MS,
  frequencyHz = ORBIT_SINE_FREQUENCY_HZ,
  sampleRate = ORBIT_SINE_SAMPLE_RATE,
): number {
  const numSamples = orbitSineSampleCount(durationMs, frequencyHz, sampleRate);
  return (numSamples / sampleRate) * 1000;
}

/** Looping sine WAV as base64 for {@link play} inline bytes. */
export function buildOrbitSineInlineClipBase64(
  durationMs = ORBIT_SINE_DURATION_MS,
  frequencyHz = ORBIT_SINE_FREQUENCY_HZ,
  amplitude = ORBIT_SINE_AMPLITUDE,
  phaseRad = 0,
): string {
  const sampleRate = ORBIT_SINE_SAMPLE_RATE;
  const channels = 1;
  const bytesPerSample = 2;
  const numSamples = orbitSineSampleCount(durationMs, frequencyHz, sampleRate);
  const dataSize = numSamples * channels * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.round(
      amplitude * Math.sin(2 * Math.PI * frequencyHz * t + phaseRad),
    );
    buffer.writeInt16LE(sample, 44 + i * 2);
  }
  return buffer.toString("base64");
}
