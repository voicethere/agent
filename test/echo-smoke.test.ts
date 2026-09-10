import { describe, expect, it } from "vitest";

import { formatEchoSpeak as crashFormatEchoSpeak } from "../templates/crash.js";
import { formatEchoSpeak } from "../templates/echo-smoke.js";

describe("formatEchoSpeak (echo-smoke)", () => {
  it('returns "echo " + trimmed text', () => {
    expect(formatEchoSpeak("One, two, three")).toBe("echo One, two, three");
  });

  it("does not use echo: or echo. sentence-breaking punctuation", () => {
    const spoken = formatEchoSpeak("One, two, three");
    expect(spoken).not.toContain("echo:One");
    expect(spoken).not.toMatch(/^echo:/);
    expect(spoken).not.toMatch(/^echo\./);
  });

  it("returns empty string for empty or whitespace-only input", () => {
    expect(formatEchoSpeak("")).toBe("");
    expect(formatEchoSpeak("   ")).toBe("");
    expect(formatEchoSpeak("\n\t")).toBe("");
  });

  it("trims surrounding whitespace from payload", () => {
    expect(formatEchoSpeak("  hello  ")).toBe("echo hello");
  });
});

describe("formatEchoSpeak (crash)", () => {
  it("uses echo. sentence boundary (distinct from echo-smoke)", () => {
    expect(crashFormatEchoSpeak("One, two, three")).toBe(
      "echo. One, two, three",
    );
    expect(crashFormatEchoSpeak("One, two, three")).not.toContain("echo:One");
    expect(formatEchoSpeak("One, two, three")).toBe("echo One, two, three");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(crashFormatEchoSpeak("  ")).toBe("");
  });
});
