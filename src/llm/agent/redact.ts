export type ToolCallLogMode = "full" | "redacted" | "off";

const MIN_SECRET_CHARS = 8;
const MAX_DEPTH = 32;

/** Matches the key itself or as a suffix (`accessToken`, `x_api_key`). */
const SENSITIVE_KEY_RE =
  /(password|passwd|secret|token|api[_-]?key|authorization|cookie|private[_-]?key)$/i;

const EMAIL_RE =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const IBAN_RE =
  /\b[A-Z]{2}\d{2}(?:[ ]?[A-Za-z0-9]{3,5}){3,8}(?:[ ]?[A-Za-z0-9]{1,3})?\b/g;
const CARD_RE = /\b\d(?:[ -]?\d){12,18}\b/g;
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/g;

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function ibanValid(raw: string): boolean {
  const s = raw.replace(/ /g, "").toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const v = code >= 65 && code <= 90 ? String(code - 55) : ch;
    if (!/^[0-9]+$/.test(v)) return false;
    for (const digit of v) rem = (rem * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

function redactPii(text: string): string {
  return text
    .replace(EMAIL_RE, "[redacted:email]")
    .replace(IBAN_RE, (m) => (ibanValid(m) ? "[redacted:iban]" : m))
    .replace(CARD_RE, (m) => {
      const digits = m.replace(/[ -]/g, "");
      return digits.length >= 13 && digits.length <= 19 && luhn(digits)
        ? "[redacted:card]"
        : m;
    })
    .replace(PHONE_RE, (m) =>
      m.replace(/\D/g, "").length >= 8 ? "[redacted:phone]" : m,
    );
}

export interface Redactor {
  redact(value: unknown): unknown;
}

/**
 * Walks JSON-like values. Secret values (from the agent's env, length >= 8) are
 * removed in every mode. `redacted` mode also removes values under sensitive
 * keys and common personal data (email, phone, card, IBAN).
 */
export function createRedactor(opts: {
  secretValues: string[];
  mode: "full" | "redacted";
}): Redactor {
  const secrets = [...new Set(opts.secretValues)]
    .filter((v) => v.length >= MIN_SECRET_CHARS)
    .sort((a, b) => b.length - a.length);
  const pii = opts.mode === "redacted";

  const redactText = (text: string): string => {
    let out = text;
    for (const s of secrets) {
      if (out.includes(s)) out = out.split(s).join("[redacted:secret]");
    }
    return pii ? redactPii(out) : out;
  };

  const walk = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") {
      const t = value.trim();
      if (
        depth < MAX_DEPTH &&
        (t.startsWith("{") || t.startsWith("[")) &&
        t.length > 1
      ) {
        try {
          return JSON.stringify(walk(JSON.parse(t), depth + 1));
        } catch {
          // not JSON: treat as text
        }
      }
      return redactText(value);
    }
    if (value === null || typeof value !== "object") return value;
    if (depth >= MAX_DEPTH) return "[redacted:depth]";
    if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const key = redactText(k);
      out[key] =
        pii && SENSITIVE_KEY_RE.test(k) ? "[redacted]" : walk(v, depth + 1);
    }
    return out;
  };

  return { redact: (value) => walk(value, 0) };
}
