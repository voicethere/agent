import { readFileSync } from "node:fs";
import { checkSync } from "recheck";
import { describe, expect, it } from "vitest";
import {
  createRedactor,
  REDACT_PATTERNS,
  secretValuesFromEnv,
} from "../../../src/llm/agent/redact.js";

// Pure-JS sync backend: no JVM or native binary at check time. See
// https://makenowjust-labs.github.io/recheck/docs/usage/as-javascript-library/
process.env.RECHECK_SYNC_BACKEND = "pure";

const SECRET = "sk-live-abcdef123456";

function red(mode: "full" | "redacted" = "redacted") {
  return createRedactor({ secretValues: [SECRET, "short"], mode });
}

describe("createRedactor", () => {
  it("removes a secret value inside nested JSON", () => {
    const out = red().redact({ a: { b: [`Bearer ${SECRET}`] } });
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(JSON.stringify(out)).toContain("[redacted:secret]");
  });

  it("removes a secret value inside a JSON string and keeps it JSON", () => {
    const out = red().redact(JSON.stringify({ note: `key ${SECRET}` }));
    expect(typeof out).toBe("string");
    expect(out as string).not.toContain(SECRET);
    expect(JSON.parse(out as string).note).toBe("key [redacted:secret]");
  });

  it("removes a secret value in full mode", () => {
    const out = red("full").redact({ q: `x ${SECRET} y` });
    expect(out).toEqual({ q: "x [redacted:secret] y" });
  });

  it("ignores secret values shorter than 8 characters", () => {
    expect(red().redact("this is short")).toBe("this is short");
  });

  it("redacts sensitive keys, also as suffix, case-insensitive", () => {
    const out = red().redact({
      Authorization: "Bearer abc",
      accessToken: "t",
      api_key: "k",
      nested: { Password: "p", city: "Berlin" },
    }) as Record<string, unknown>;
    expect(out.Authorization).toBe("[redacted]");
    expect(out.accessToken).toBe("[redacted]");
    expect(out.api_key).toBe("[redacted]");
    expect(out.nested).toEqual({ Password: "[redacted]", city: "Berlin" });
  });

  it("keeps sensitive keys in full mode", () => {
    const out = red("full").redact({ accessToken: "t" });
    expect(out).toEqual({ accessToken: "t" });
  });

  it("redacts emails, phones and IBANs", () => {
    const out = red().redact(
      "mail jane.doe@example.com call +1 415 555 2671 pay DE89 3704 0044 0532 0130 00",
    ) as string;
    expect(out).toContain("[redacted:email]");
    expect(out).toContain("[redacted:phone]");
    expect(out).toContain("[redacted:iban]");
    expect(out).not.toContain("jane.doe");
  });

  it("redacts a Luhn-valid card number and not an invalid one", () => {
    expect(red().redact("card 4111 1111 1111 1111")).toBe(
      "card [redacted:card]",
    );
    expect(red().redact("card 4111111111111112") as string).not.toContain(
      "[redacted:card]",
    );
  });

  it("leaves non-PII numbers alone", () => {
    expect(red().redact("order 12345 qty 3")).toBe("order 12345 qty 3");
    expect(red().redact({ id: 12345 })).toEqual({ id: 12345 });
  });

  it("does not redact PII in full mode", () => {
    expect(red("full").redact("a@b.com")).toBe("a@b.com");
  });

  it("leaves timestamps, ids and IPs alone", () => {
    for (const v of [
      "2026-10-27T12:34:56.789Z",
      "on 2026-10-27 at 12:00",
      "1761571200000",
      "1761571200000000",
      "550e8400-e29b-41d4-a716-446655440000",
      "order 12345678",
      "192.168.100.200",
      "1234.5678",
      "4111111111111112",
    ]) {
      expect(red().redact(v)).toBe(v);
    }
  });

  it("redacts formatted phones", () => {
    expect(red().redact("+49 30 1234567")).toBe("[redacted:phone]");
    expect(red().redact("+14155552671")).toBe("[redacted:phone]");
    expect(red().redact("call (415) 555-2671 now")).toBe(
      "call [redacted:phone] now",
    );
    expect(red().redact("415 555 2671")).toContain("[redacted:phone]");
    expect(red().redact("415.555.2671")).toContain("[redacted:phone]");
  });

  it("redacts cards", () => {
    for (const v of [
      "4111 1111 1111 1111",
      "4111-1111-1111-1111",
      "378282246310005",
    ]) {
      expect(red().redact(v)).toBe("[redacted:card]");
    }
  });

  it("secret values come from AGENT_* and referenced names only", () => {
    const values = secretValuesFromEnv(
      {
        NODE_ENV: "production",
        SESSION_ID: "6f1c2a9e-0000-4000-8000-000000000001",
        AGENT_SERVICE_URL: "http://svc.local:8080",
        AGENT_X_KEY: "abcdefgh12",
        MY_KEY: "zzzzzzzz9",
      },
      ["MY_KEY"],
    );
    expect([...values].sort()).toEqual(["abcdefgh12", "zzzzzzzz9"]);
    const r = createRedactor({ secretValues: values, mode: "redacted" });
    expect(r.redact("production abcdefgh12")).toBe(
      "production [redacted:secret]",
    );
  });

  // ReDoS guard, static: recheck's automaton checker decides each pattern's
  // complexity from the regex itself. No time limit and no fuzzing, so the
  // verdict does not depend on how much CPU the test gets (a CPU-time ratio
  // flaked under host load).
  const RECHECK_PARAMS = {
    checker: "automaton",
    timeout: null,
  } as const;
  const complexity = (re: RegExp): string =>
    checkSync(re.source, re.flags, RECHECK_PARAMS).status;

  it("REDACT_PATTERNS lists every regex in redact.ts", () => {
    const src = readFileSync(
      new URL("../../../src/llm/agent/redact.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toMatch(/\bRegExp\(/);
    const declared = [...src.matchAll(/^const (\w+)\s*=\s*\/(?!\/)/gm)]
      .map((m) => m[1])
      .sort();
    expect(declared).toEqual(Object.keys(REDACT_PATTERNS).sort());
    expect(src).not.toMatch(
      /\.(?:replace|replaceAll|match|matchAll|search|split|test|exec)\(\s*\//,
    );
    expect(src).not.toMatch(/\/[dgimsuyv]*\.(?:test|exec|source)\b/);
  });

  it("every redactor pattern is safe (no super-linear backtracking)", () => {
    for (const [name, re] of Object.entries(REDACT_PATTERNS)) {
      expect({ name, status: complexity(re) }).toEqual({
        name,
        status: "safe",
      });
    }
  });

  // The mutants are source strings, never compiled, so no slow regex exists in the test.
  it("the ReDoS checker flags super-linear mutants", () => {
    for (const source of ["(a+)+@", "\\s*\\d+\\s*x"]) {
      expect({
        source,
        status: checkSync(source, "", RECHECK_PARAMS).status,
      }).toEqual({
        source,
        status: "vulnerable",
      });
    }
  });

  // isPhone, luhn and redactIbanCandidate only run on a match of these
  // patterns, so their loops are bounded by the longest possible match.
  it("hand-written helpers only see candidates the patterns cap", () => {
    const n = 50_000;
    const caps: Array<[RegExp, number, string[]]> = [
      // \b[A-Z]{2}\d{2}[A-Za-z0-9 ]{11,40}: 2 + 2 + 40
      [
        REDACT_PATTERNS.IBAN_CANDIDATE_RE,
        44,
        [
          "DE12".repeat(n / 4),
          `DE12${"A".repeat(n)}`,
          `DE12${"1 ".repeat(n / 2)}`,
        ],
      ],
      // \b\d(?:[ -]?\d){14,18}\b: 1 + 2 * 18
      [
        REDACT_PATTERNS.CARD_RE,
        37,
        ["1".repeat(n), "1-".repeat(n / 2), "4111 ".repeat(n / 5)],
      ],
      // (?:\+|\()?\d[\d ().-]{6,22}\d: 1 + 1 + 22 + 1
      [
        REDACT_PATTERNS.PHONE_RE,
        25,
        ["1 ".repeat(n / 2), `+1${"2".repeat(n)}`, `(1${" 2".repeat(n / 2)}`],
      ],
    ];
    for (const [re, cap, inputs] of caps) {
      for (const input of inputs) {
        const longest = Math.max(
          0,
          ...[...input.matchAll(re)].map((m) => m[0].length),
        );
        expect(longest).toBeLessThanOrEqual(cap);
      }
    }
  });

  it("adversarial inputs redact correctly", () => {
    const r = red();
    const n = 50_000;
    const unchanged = [
      "%".repeat(n),
      "a@".repeat(n / 2),
      "DE12".repeat(n / 4),
      "1-".repeat(n / 2),
      "4111 ".repeat(n / 5),
      "+".repeat(n),
      `${"a".repeat((n * 3) / 5)}@${"b.".repeat(n / 5)}`,
    ];
    for (const input of unchanged) expect(r.redact(input)).toBe(input);
    const spaced = r.redact("1 ".repeat(n / 2));
    expect(typeof spaced).toBe("string");
    expect(spaced).toContain("[redacted:phone]");
    expect(String(spaced).replace(/\[redacted:phone\]|[ 1]/g, "")).toBe("");
  });

  it("an IBAN followed by words is redacted without eating the words", () => {
    expect(red().redact("pay DE89 3704 0044 0532 0130 00 now")).toBe(
      "pay [redacted:iban] now",
    );
  });

  it("redacts long space-grouped IBANs whole", () => {
    for (const v of [
      "MT84 MALT 0110 0001 2345 MTLC AST0 01S",
      "MU17 BOMM 0101 1010 3030 0200 000M UR",
      "BR15 0000 0000 0000 1093 2840 814P 2",
    ]) {
      expect(red().redact(v)).toBe("[redacted:iban]");
    }
    expect(red().redact("DE89 3704 0044 0532 0130 00 now")).toBe(
      "[redacted:iban] now",
    );
  });

  it("an IBAN-shaped word before a real IBAN does not hide it", () => {
    const out = red().redact("ref AB12 DE89370400440532013000") as string;
    expect(out).toContain("[redacted:iban]");
    expect(out).not.toContain("DE89370400440532013000");
  });
});
