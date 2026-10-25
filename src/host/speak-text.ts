/** Fallback speaking rate: 14 characters per second. */
export const DEFAULT_CHARS_PER_MS = 0.014;

/**
 * Split `text` into the part the caller probably heard and the rest, from how much of
 * the audio played. The cut snaps back to the previous word boundary.
 */
export function estimatePlayedText(
  text: string,
  playedMs: number,
  audioMs: number,
): { played: string; unplayed: string } {
  if (audioMs <= 0 || playedMs <= 0) return { played: "", unplayed: text };
  if (playedMs >= audioMs) return { played: text, unplayed: "" };
  const n = Math.round((text.length * playedMs) / audioMs);
  const i = Math.max(text.lastIndexOf(" ", n), text.lastIndexOf("\n", n));
  if (i < 0) return { played: "", unplayed: text };
  return {
    played: text.slice(0, i).trimEnd(),
    unplayed: text.slice(i).trimStart(),
  };
}
