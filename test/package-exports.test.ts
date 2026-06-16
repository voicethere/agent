import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const script = join(root, "scripts/ci/verify-package-exports.mjs");

describe("package exports (CJS/tsx resolution)", () => {
  it("passes verify-package-exports.mjs after build", () => {
    const out = execFileSync(process.execPath, [script], {
      cwd: root,
      encoding: "utf8",
    });
    expect(out.trim()).toBe("verify-package-exports: ok");
  });
});
