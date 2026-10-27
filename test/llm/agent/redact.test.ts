import { describe, expect, it } from "vitest";
import { createRedactor } from "../../../src/llm/agent/redact.js";

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
});
