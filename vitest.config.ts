import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Templates import `@voicethere/agent`; point tests at src, not stale dist.
      "@voicethere/agent": fileURLToPath(
        new URL("./src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000,
  },
});
