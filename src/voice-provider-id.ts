const BUILT_IN_ALIASES = new Set([
  "voicethere",
  "local-sherpa",
  "cluster-sherpa",
]);

/**
 * Id that goes on the wire to the VoiceThere runtime. `voicethere` (the
 * built-in speech) and its deprecated aliases `local-sherpa` / `cluster-sherpa`
 * all become `local-sherpa`, which every runtime version understands. Cloud ids
 * are trimmed and keep their case.
 */
export function toWireProviderId(id: string): string {
  const trimmed = id.trim();
  return BUILT_IN_ALIASES.has(trimmed.toLowerCase()) ? "local-sherpa" : trimmed;
}

/**
 * Id that agent code sees. The runtime's internal ids for the built-in speech
 * (`local-sherpa`, `cluster-sherpa`) are shown as `voicethere`; other ids are
 * unchanged.
 */
export function toPublicProviderId(id: string): string {
  const lower = id.trim().toLowerCase();
  return lower === "local-sherpa" || lower === "cluster-sherpa"
    ? "voicethere"
    : id;
}
