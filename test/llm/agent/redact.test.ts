import { describe, expect, it } from "vitest";
import {
  createRedactor,
  secretValuesFromEnv,
} from "../../../src/llm/agent/redact.js";

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

  it("adversarial 50 000-character inputs finish quickly", () => {
    const r = red();
    for (const input of [
      "%".repeat(50_000),
      "1 ".repeat(25_000),
      "a@".repeat(25_000),
      "DE12".repeat(12_500),
      "1-".repeat(25_000),
      "4111 ".repeat(10_000),
      "+".repeat(50_000),
      `${"a".repeat(30_000)}@${"b.".repeat(10_000)}`,
    ]) {
      const t0 = performance.now();
      r.redact(input);
      expect(performance.now() - t0).toBeLessThan(200);
    }
  });

  it("an IBAN followed by words is redacted without eating the words", () => {
    expect(red().redact("pay DE89 3704 0044 0532 0130 00 now")).toBe(
      "pay [redacted:iban] now",
    );
  });
});
