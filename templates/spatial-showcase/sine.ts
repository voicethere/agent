/** Inline orbit sine clip — 16 kHz mono s16le, decoded size under 64 KiB play cap. */

/** 2 s keeps loop-restart gaps (250 ms poll) infrequent; 16 kHz mono still fits under 64 KiB. */
export const ORBIT_SINE_DURATION_MS = 2000;
export const ORBIT_SINE_FREQUENCY_HZ = 440;
export const ORBIT_SINE_AMPLITUDE = 8000;
export const ORBIT_SINE_INLINE_URL =
  "https://example.com/inline-orbit-sine.wav";

/** Looping ~440 Hz sine WAV as base64 for {@link play} inline bytes. */
export function buildOrbitSineInlineClipBase64(
  durationMs = ORBIT_SINE_DURATION_MS,
  frequencyHz = ORBIT_SINE_FREQUENCY_HZ,
  amplitude = ORBIT_SINE_AMPLITUDE,
): string {
  const sampleRate = 16_000;
  const channels = 1;
  const bytesPerSample = 2;
  const numSamples = Math.floor((sampleRate * durationMs) / 1000);
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
      amplitude * Math.sin(2 * Math.PI * frequencyHz * t),
    );
    buffer.writeInt16LE(sample, 44 + i * 2);
  }
  return buffer.toString("base64");
}
