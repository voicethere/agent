import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AGENT_TEMPLATES } from "../src/templates/index.js";

const templatesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "templates",
);

describe("template folders", () => {
  it("keeps each registered template in its own folder with a README", () => {
    const rootTs = fs
      .readdirSync(templatesDir)
      .filter((name) => name.endsWith(".ts"));
    expect(rootTs).toEqual([]);

    for (const template of AGENT_TEMPLATES) {
      expect(template.entry.startsWith(`${template.id}/`)).toBe(true);
      expect(template.entry.endsWith("/agent.ts")).toBe(true);
      const readmePath = join(templatesDir, template.id, "README.md");
      expect(fs.existsSync(readmePath), `missing ${readmePath}`).toBe(true);
      const readme = fs.readFileSync(readmePath, "utf8");
      expect(readme).toMatch(new RegExp(`^# ${template.id}\\b`, "m"));
      expect(readme).toContain(`templates/${template.entry}`);
    }
  });
});
