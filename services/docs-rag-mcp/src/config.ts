export interface SearchConfig {
  vectorWeight: number;
  textWeight: number;
  maxPerDoc: number;
}

export const DEFAULT_VECTOR_WEIGHT = 1.0;
export const DEFAULT_TEXT_WEIGHT = 0.5;
export const DEFAULT_MAX_PER_DOC = 2;

function num(
  name: string,
  raw: string | undefined,
  fallback: number,
  int = false,
): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (
    !Number.isFinite(n) ||
    n < 0 ||
    (int && (!Number.isInteger(n) || n < 1))
  ) {
    throw new RangeError(
      `${name} must be ${int ? "a positive integer" : "a non-negative number"}`,
    );
  }
  return n;
}

/**
 * The one place search settings are read: explicit overrides (CLI flags) win
 * over env (`DOCS_RAG_VECTOR_WEIGHT`, `DOCS_RAG_TEXT_WEIGHT`,
 * `DOCS_RAG_MAX_PER_DOC`), which win over the defaults.
 */
export function searchConfig(
  overrides: Partial<
    Record<keyof SearchConfig, string | number | undefined>
  > = {},
  env: Record<string, string | undefined> = process.env,
): SearchConfig {
  const pick = (k: keyof SearchConfig, e: string): string | undefined =>
    overrides[k] !== undefined ? String(overrides[k]) : env[e];
  return {
    vectorWeight: num(
      "vector weight",
      pick("vectorWeight", "DOCS_RAG_VECTOR_WEIGHT"),
      DEFAULT_VECTOR_WEIGHT,
    ),
    textWeight: num(
      "text weight",
      pick("textWeight", "DOCS_RAG_TEXT_WEIGHT"),
      DEFAULT_TEXT_WEIGHT,
    ),
    maxPerDoc: num(
      "max per doc",
      pick("maxPerDoc", "DOCS_RAG_MAX_PER_DOC"),
      DEFAULT_MAX_PER_DOC,
      true,
    ),
  };
}
