import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const templatesDir = fileURLToPath(new URL("../templates", import.meta.url));

// Thinking models spend hidden reasoning tokens against maxOutputTokens; at
// 300 the answer round after a tool call ended with finish_reason=length.
describe.each(["llm-agent", "llm-docs-rag", "llm-mcp-service"])(
  "%s template output cap",
  (name) => {
    it("sets maxOutputTokens to 1024", () => {
      const config = JSON.parse(
        readFileSync(join(templatesDir, name, "voicethere.llm.json"), "utf8"),
      ) as { maxOutputTokens?: number };
      expect(config.maxOutputTokens).toBe(1024);
    });

    it("README explains why the cap is not used to keep replies short", () => {
      const readme = readFileSync(
        join(templatesDir, name, "README.md"),
        "utf8",
      );
      expect(readme).toContain(
        "Thinking models count hidden reasoning against `maxOutputTokens`",
      );
    });
  },
);
