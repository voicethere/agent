import { describe, expect, it } from "vitest";

import { formatEchoSpeak as crashFormatEchoSpeak } from "../templates/crash.js";
import { formatEchoSpeak } from "../templates/echo-smoke.js";

describe("formatEchoSpeak (echo-smoke)", () => {
  it('returns "echo. " + trimmed text with sentence boundary', () => {
    expect(formatEchoSpeak("One, two, three")).toBe("echo. One, two, three");
  });

  it("does not glue echo: onto the next word", () => {
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
    expect(formatEchoSpeak("  hello  ")).toBe("echo. hello");
  });
});

describe("formatEchoSpeak (crash)", () => {
  it("matches echo-smoke helper", () => {
    expect(crashFormatEchoSpeak("One, two, three")).toBe(
      "echo. One, two, three",
    );
    expect(crashFormatEchoSpeak("One, two, three")).not.toContain("echo:One");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(crashFormatEchoSpeak("  ")).toBe("");
  });
});
