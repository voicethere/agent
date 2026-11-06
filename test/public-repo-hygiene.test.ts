import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * This repo is public. No tracked file may name or link a private VoiceThere
 * repo. Public repos: agent, cli, client.
 */
const PRIVATE_SLUG =
  /voicethere\/(development|platform|deploy|deployment|runner|orchestrator|signaling-gateway|session-service|speech-service|e2e|compile-worker)\b/;
const OTHER_GITHUB_LINK = /github\.com\/voicethere\/(?!(agent|cli|client)\b)/;

const root = resolve(import.meta.dirname, "..");

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
}

export function findHygieneViolations(
  files: Array<{ path: string; text: string }>,
): string[] {
  const hits: string[] = [];
  for (const file of files) {
    file.text.split("\n").forEach((line, index) => {
      if (PRIVATE_SLUG.test(line) || OTHER_GITHUB_LINK.test(line)) {
        hits.push(`${file.path}:${index + 1}: ${line.trim().slice(0, 120)}`);
      }
    });
  }
  return hits;
}

describe("public repo hygiene", () => {
  it("flags a private slug and a private github link, not the public repos", () => {
    const sample = (text: string) => [{ path: "x.md", text }];
    // Built from parts so this file does not contain a slug itself.
    const org = "voicethere";
    expect(findHygieneViolations(sample(`see ${org}/e2e smokes`))).toHaveLength(
      1,
    );
    expect(
      findHygieneViolations(sample(`https://github.com/${org}/platform`)),
    ).toHaveLength(1);
    expect(
      findHygieneViolations(sample(`${org}/cli and ${org}/agent`)),
    ).toEqual([]);
    expect(findHygieneViolations(sample("@voicethere/agent"))).toEqual([]);
  });

  it("has no private repo slug in any tracked file", () => {
    const files = trackedFiles()
      .filter((path) => !path.endsWith("package-lock.json"))
      .flatMap((path) => {
        try {
          const text = readFileSync(resolve(root, path), "utf8");
          return text.includes("\0") ? [] : [{ path, text }];
        } catch {
          return [];
        }
      });
    expect(findHygieneViolations(files)).toEqual([]);
  });
});
