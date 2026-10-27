export type ToolCallLogMode = "full" | "redacted" | "off";

const MIN_SECRET_CHARS = 8;
const MAX_DEPTH = 32;

/** Matches the key itself or as a suffix (`accessToken`, `x_api_key`). */
const SENSITIVE_KEY_RE =
  /(password|passwd|secret|token|api[_-]?key|authorization|cookie|private[_-]?key)$/i;

// Every quantifier below is bounded, so no pattern backtracks more than a
// constant factor per start position (js/polynomial-redos).
const EMAIL_RE =
  /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}/g;
const IBAN_CANDIDATE_RE = /\b[A-Z]{2}\d{2}[A-Za-z0-9 ]{11,30}/g;
const CARD_RE = /\b\d(?:[ -]?\d){14,18}\b/g;
const PHONE_RE = /(?<![\w.:/+-])(?:\+|\()?\d[\d ().-]{6,22}\d(?![\w.:/-])/g;
/** Longest text the PII patterns see; the rest is dropped (the log line is cut far below this). */
const MAX_PII_CHARS = 65_536;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isPhone(m: string): boolean {
  const d = m.replace(/\D/g, "");
  if (d.length < 8 || d.length > 15) return false;
  if (IPV4_RE.test(m) || ISO_DATE_RE.test(m)) return false;
  if (m.startsWith("+") || m.includes("(")) return true;
  return (m.match(/[ .-]/g) ?? []).length >= 2;
}

const NON_SECRET_AGENT_KEYS = new Set([
  "AGENT_CUSTOMER_CONTEXT",
  "AGENT_SERVICE_URL",
]);

/** Project secrets are the AGENT_* variables plus any variable the config names. */
export function secretValuesFromEnv(
  env: Record<string, string | undefined>,
  referenced: string[],
): string[] {
  const names = new Set(referenced);
  for (const k of Object.keys(env)) {
    if (k.startsWith("AGENT_") && !NON_SECRET_AGENT_KEYS.has(k)) names.add(k);
  }
  return [...names]
    .map((n) => env[n])
    .filter((v): v is string => typeof v === "string");
}

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

/** The candidate may run past the IBAN into the next word: try shorter ends. */
function redactIbanCandidate(m: string): string {
  for (let end = m.length; end >= 15; end -= 1) {
    const head = m.slice(0, end);
    if (head.endsWith(" ")) continue;
    if (ibanValid(head)) return `[redacted:iban]${m.slice(end)}`;
  }
  return m;
}

function redactPii(input: string): string {
  const text =
    input.length > MAX_PII_CHARS
      ? `${input.slice(0, MAX_PII_CHARS)}[truncated]`
      : input;
  return text
    .replace(EMAIL_RE, "[redacted:email]")
    .replace(IBAN_CANDIDATE_RE, redactIbanCandidate)
    .replace(CARD_RE, (m) => {
      const digits = m.replace(/[ -]/g, "");
      return [15, 16, 19].includes(digits.length) &&
        "3456".includes(digits[0]) &&
        luhn(digits)
        ? "[redacted:card]"
        : m;
    })
    .replace(PHONE_RE, (m) => (isPhone(m) ? "[redacted:phone]" : m));
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
