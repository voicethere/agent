import { describe, expect, it } from "vitest";

import { formatEchoSpeak as crashFormatEchoSpeak } from "../templates/crash.js";
import { formatEchoSpeak } from "../templates/echo-smoke.js";

describe("formatEchoSpeak (echo-smoke)", () => {
  it('returns "Okay. " + trimmed text', () => {
    expect(formatEchoSpeak("One, two, three")).toBe("Okay. One, two, three");
    expect(formatEchoSpeak("one two")).toBe("Okay. one two");
  });

  it("does not use echo: glued to the payload", () => {
    const spoken = formatEchoSpeak("One, two, three");
    expect(spoken).not.toContain("echo:One");
    expect(spoken).not.toMatch(/^echo:/);
  });

  it("returns empty string for empty or whitespace-only input", () => {
    expect(formatEchoSpeak("")).toBe("");
    expect(formatEchoSpeak("   ")).toBe("");
    expect(formatEchoSpeak("\n\t")).toBe("");
  });

  it("trims surrounding whitespace from payload", () => {
    expect(formatEchoSpeak("  hello  ")).toBe("Okay. hello");
  });
});

describe("formatEchoSpeak (crash)", () => {
  it("uses Okay. sentence boundary (same as echo-smoke)", () => {
    expect(crashFormatEchoSpeak("One, two, three")).toBe(
      "Okay. One, two, three",
    );
    expect(crashFormatEchoSpeak("One, two, three")).not.toContain("echo:One");
    expect(formatEchoSpeak("One, two, three")).toBe(
      crashFormatEchoSpeak("One, two, three"),
    );
  });

  it("returns empty string for whitespace-only input", () => {
    expect(crashFormatEchoSpeak("  ")).toBe("");
  });
});
