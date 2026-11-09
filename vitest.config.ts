import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { localWorkerLimit } from "./vitest.workers";

export default defineConfig(async () => ({
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
    include: ["test/**/*.test.ts", "vitest.workers.test.ts"],
    testTimeout: 15_000,
    // Caps local vitest workers across concurrent runs on one machine; no effect in CI.
    ...(await localWorkerLimit()),
  },
}));
