import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guard (rule test-shared-state-isolated): a test that writes under test/.tmp
// must create its own directory with mkdtemp, so two runs in one checkout never
// delete each other's files.

const __filename = fileURLToPath(import.meta.url);
const TEST_DIR = dirname(__filename);
const TMP_LITERAL = /["']\.tmp["']/;

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".tmp") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("test temp dirs are isolated per run", () => {
  it("every test file that joins test/.tmp creates its dir with mkdtemp", () => {
    const offenders = listTsFiles(TEST_DIR)
      .filter((file) => file !== __filename)
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        return (
          TMP_LITERAL.test(source) &&
          !source.includes("mkdtempSync(") &&
          !source.includes("mkdtemp(")
        );
      })
      .map((file) => relative(TEST_DIR, file));

    expect(
      offenders,
      `these files use test/.tmp without mkdtempSync/mkdtemp (rule test-shared-state-isolated): ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
