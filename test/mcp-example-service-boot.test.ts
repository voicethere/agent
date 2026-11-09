import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const server = fileURLToPath(
  new URL("../services/mcp-example/server.ts", import.meta.url),
);

// The image runs `node server.ts` (Dockerfile CMD): plain node, no loader, so
// Node's strip-only type stripping must accept the file. Node 26 (CI + image).
it("boots with plain node (strip-only type stripping) and answers /healthz", async () => {
  const child = spawn(process.execPath, [server], {
    env: { ...process.env, PORT: "0", MCP_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const exited = new Promise<number | null>((r) => child.on("exit", r));
  try {
    const deadline = Date.now() + 15_000;
    let port = 0;
    while (Date.now() < deadline && !port) {
      const m = /"event":"listening","port":(\d+)/.exec(out);
      if (m) port = Number(m[1]);
      else if (child.exitCode !== null) break;
      else await new Promise((r) => setTimeout(r, 100));
    }
    expect(port, `server did not start; stderr:\n${err}`).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
  } finally {
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
    child.kill("SIGKILL");
  }
}, 30_000);
