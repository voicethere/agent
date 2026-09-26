/**
 * Showcase clip catalog — browser sends clipId only; the agent resolves URLs here.
 *
 * Production agents receive `assetOrigin` from the browser's `window.location.origin`
 * (typically https://app.voicethere.io or https://app.voicethere.dev). Local dev may
 * use http://localhost:3000 — also allowlisted for resolveClipUrl.
 */
export type ShowcaseClipId =
  | "chime"
  | "bell"
  | "laser"
  | "impact"
  | "footsteps"
  | "rain-loop"
  | "cafe-loop"
  | "jingle";

export type ShowcaseSoundFile = {
  file: string;
  loop: boolean;
  defaultVolume: number;
};

export const SHOWCASE_SOUND_FILES: Record<ShowcaseClipId, ShowcaseSoundFile> = {
  chime: { file: "chime.wav", loop: false, defaultVolume: 0.8 },
  bell: { file: "bell.wav", loop: false, defaultVolume: 0.8 },
  laser: { file: "laser.wav", loop: false, defaultVolume: 0.7 },
  impact: { file: "impact.wav", loop: false, defaultVolume: 0.85 },
  footsteps: { file: "footsteps.wav", loop: false, defaultVolume: 0.75 },
  "rain-loop": { file: "rain-loop.wav", loop: true, defaultVolume: 0.5 },
  "cafe-loop": { file: "cafe-loop.wav", loop: true, defaultVolume: 0.5 },
  jingle: { file: "jingle.wav", loop: false, defaultVolume: 0.8 },
};

export const SHOWCASE_ASSET_ORIGINS = [
  "https://app.voicethere.io",
  "https://app.voicethere.dev",
  "https://www.voicethere.io",
  "https://voicethere.io",
  "http://localhost:3000",
] as const;

const CLIP_IDS = new Set<string>(Object.keys(SHOWCASE_SOUND_FILES));

export function isShowcaseClipId(clipId: string): clipId is ShowcaseClipId {
  return CLIP_IDS.has(clipId);
}

function normalizeOrigin(origin: string): string {
  return origin.replace(/\/+$/, "");
}

function isAllowedOrigin(origin: string): boolean {
  const normalized = normalizeOrigin(origin);
  return SHOWCASE_ASSET_ORIGINS.some(
    (allowed) => normalizeOrigin(allowed) === normalized,
  );
}

/** Resolve a clip URL from an allowlisted asset origin and clipId — never accept arbitrary URLs. */
export function resolveClipUrl(
  assetOrigin: string,
  clipId: string,
): string | null {
  if (!isAllowedOrigin(assetOrigin) || !isShowcaseClipId(clipId)) {
    return null;
  }
  const { file } = SHOWCASE_SOUND_FILES[clipId];
  return `${normalizeOrigin(assetOrigin)}/showcase/sounds/${file}`;
}
