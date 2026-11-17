import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { RUNNER_FORWARDED_SPEECH_EVENTS } from "../src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const forwarded: readonly string[] = RUNNER_FORWARDED_SPEECH_EVENTS;

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function readmeTableEvents(): string[] {
  const readme = read("README.md");
  const start = readme.indexOf("### Speech events (parent → child)");
  const end = readme.indexOf("\n### ", start + 1);
  const section = readme.slice(start, end);
  const rows: string[] = [];
  for (const line of section.split("\n")) {
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
    expect([...readmeTableEvents()].sort()).toEqual([...forwarded].sort());
  });

  it.each(["templates/voice-starter/agent.ts", "examples/agent.ts"])(
    "%s switch cases are a subset of the list",
    (path) => {
      const cases = switchCases(path);
      expect(cases.length).toBeGreaterThan(0);
      for (const c of cases) expect(forwarded).toContain(c);
    },
  );
});
