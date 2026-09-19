import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const GITHUB_PERMALINK_RE =
  /https:\/\/github\.com\/voicethere\/agent\/(?:blob|tree)\/[^/\s)"']+\/([^\s)"']+)/g;
const RELATIVE_MD_LINK_RE = /\[[^\]]+\]\((\.\/[^)\s]+)\)/g;

function collectMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectMarkdownFiles(full));
    } else if (entry.name.endsWith(".md") && entry.name !== "CHANGELOG.md") {
      out.push(full);
    }
  }
  return out;
}

describe("agent markdown permalinks", () => {
  const files = collectMarkdownFiles(root);

  it("resolves GitHub agent permalinks and relative markdown links to local files", () => {
    const missing: string[] = [];

    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(GITHUB_PERMALINK_RE)) {
        const repoPath = decodeURIComponent(match[1]!.replace(/#.*$/, ""));
        const absolute = join(root, repoPath);
        if (!fs.existsSync(absolute)) {
          missing.push(`${relative(root, file)} -> ${match[0]}`);
        }
      }
      for (const match of source.matchAll(RELATIVE_MD_LINK_RE)) {
        const href = match[1]!.replace(/#.*$/, "");
        const absolute = resolve(dirname(file), href);
        if (!fs.existsSync(absolute)) {
          missing.push(`${relative(root, file)} -> ${href}`);
        }
      }
    }

    expect(missing, missing.join("\n")).toEqual([]);
  });
});
