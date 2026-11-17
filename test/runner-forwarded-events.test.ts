import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  RUNNER_FORWARDED_SPEECH_EVENTS,
  RUNNER_LANGUAGE_SWITCH_EVENTS,
} from "../src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const forwarded: readonly string[] = RUNNER_FORWARDED_SPEECH_EVENTS;
const languageSwitch: readonly string[] = RUNNER_LANGUAGE_SWITCH_EVENTS;

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function readmeSection(): string {
  const readme = read("README.md");
  const start = readme.indexOf("### Speech events (parent → child)");
  const end = readme.indexOf("\n### ", start + 1);
  return readme.slice(start, end);
}

function readmeTableEvents(second: boolean): string[] {
  const section = readmeSection();
  const marker = section.indexOf("Sent only when the project uses language switching");
  const part = second ? section.slice(marker) : section.slice(0, marker);
  const rows: string[] = [];
  for (const line of part.split("\n")) {
    const m = /^\| `([a-z_]+)`/.exec(line);
    if (m) rows.push(m[1] as string);
  }
  return rows;
}

function switchCases(path: string): string[] {
  const src = read(path);
  const start = src.indexOf("switch (speech.type)");
  const end = src.indexOf("\ndefineAgent", start);
  return [...src.slice(start, end).matchAll(/case "([a-z_]+)":/g)].map(
    (m) => m[1] as string,
  );
}

describe("RUNNER_FORWARDED_SPEECH_EVENTS", () => {
  it("has no duplicates", () => {
    expect(new Set(forwarded).size).toBe(forwarded.length);
  });

  it("README speech event table rows equal the exported list", () => {
    expect([...readmeTableEvents(false)].sort()).toEqual([...forwarded].sort());
  });

  it("README language-switch table rows equal RUNNER_LANGUAGE_SWITCH_EVENTS", () => {
    expect([...readmeTableEvents(true)].sort()).toEqual(
      [...languageSwitch].sort(),
    );
  });

  it("the two lists are disjoint", () => {
    for (const e of languageSwitch) expect(forwarded).not.toContain(e);
  });

  it("README agent_speak_failed row names `reason`", () => {
    const row = readmeSection()
      .split("\n")
      .find((l) => l.startsWith("| `agent_speak_failed`"));
    expect(row).toContain("`reason`");
  });

  it.each(["templates/voice-starter/agent.ts", "examples/agent.ts"])(
    "%s switch cases are a subset of both lists",
    (path) => {
      const cases = switchCases(path);
      expect(cases.length).toBeGreaterThan(0);
      for (const c of cases) {
        expect([...forwarded, ...languageSwitch]).toContain(c);
      }
    },
  );
});
