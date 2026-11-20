import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";

const child = fileURLToPath(
  new URL("./helpers/test-redis-leak.child.ts", import.meta.url),
);

const dockerUp =
  spawnSync("docker", ["info"], { encoding: "utf8" }).status === 0;
const skipReason = dockerUp ? undefined : "docker is not available";

function containersForPid(pid: number): string[] {
  const out = spawnSync(
    "docker",
    [
      "ps",
      "-aq",
      "--filter",
      "label=voicethere-agent-test=1",
      "--filter",
      `label=voicethere-agent-test-pid=${pid}`,
    ],
    { encoding: "utf8" },
  );
  return out.stdout.split("\n").filter(Boolean);
}

// `node --import tsx` keeps the child's pid equal to the pid in the label.
function startChild(extraEnv: Record<string, string>): {
  proc: ChildProcess;
  output: Promise<{ state: string; pid: number; labelled: number }>;
  exited: Promise<void>;
} {
  const proc = spawn(process.execPath, ["--import", "tsx", child], {
    env: {
      ...process.env,
      AGENT_TEST_REDIS_FORCE_DOCKER: "1",
      AGENT_TEST_REDIS_DOCKER: "1",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const output = new Promise<{ state: string; pid: number; labelled: number }>(
    (resolve, reject) => {
      let buf = "";
      proc.stdout!.on("data", (c: Buffer) => {
        buf += c.toString("utf8");
        const m = /(OPENED|NO_REDIS) (\d+) (\d+)/.exec(buf);
        if (m)
          resolve({ state: m[1]!, pid: Number(m[2]), labelled: Number(m[3]) });
      });
      // "close" fires after stdout is drained, so a reported line is never lost.
      // No-op once resolved; fails fast when the child dies before reporting.
      proc.on("close", (code, signal) =>
        reject(
          new Error(
            `child exited before reporting: code ${code} signal ${signal}`,
          ),
        ),
      );
    },
  );
  const exited = new Promise<void>((resolve) =>
    proc.on("exit", () => resolve()),
  );
  return { proc, output, exited };
}

describe.skipIf(Boolean(skipReason))(
  `openTestRedis docker path leaves no container behind${skipReason ? ` (skipped: ${skipReason})` : ""}`,
  () => {
    it("removes the container when the process exits without close()", async () => {
      const { output, exited } = startChild({});
      const { state, pid, labelled } = await output;
      await exited;
      expect(state).toBe("OPENED");
      expect(labelled).toBe(1);
      expect(containersForPid(pid)).toEqual([]);
    }, 60_000);

    it("removes the container when the process is terminated by SIGTERM", async () => {
      const { proc, output, exited } = startChild({ LEAK_CHILD_HANG: "1" });
      const { state, pid } = await output;
      expect(state).toBe("OPENED");
      expect(containersForPid(pid)).toHaveLength(1);
      proc.kill("SIGTERM");
      await exited;
      expect(containersForPid(pid)).toEqual([]);
    }, 60_000);

    it("removes the container of a SIGKILLed run on the next docker spawn", async () => {
      const { proc, output, exited } = startChild({ LEAK_CHILD_HANG: "1" });
      const { state, pid, labelled } = await output;
      expect(state).toBe("OPENED");
      // Checked while the pid is alive: no parallel run may reap it yet.
      expect(labelled).toBe(1);
      expect(containersForPid(pid)).toHaveLength(1);
      proc.kill("SIGKILL");
      await exited;
      const next = startChild({});
      await next.output;
      await next.exited;
      expect(containersForPid(pid)).toEqual([]);
    }, 90_000);

    it("keeps a stale-looking container that belongs to another host", async () => {
      const deadPid = 2_000_000_000;
      const run = spawnSync(
        "docker",
        [
          "run",
          "-d",
          "--rm",
          "--label",
          "voicethere-agent-test=1",
          "--label",
          `voicethere-agent-test-pid=${deadPid}`,
          "--label",
          "voicethere-agent-test-host=other-pid-namespace",
          "redis:7-alpine",
        ],
        { encoding: "utf8" },
      );
      const id = run.stdout.trim();
      if (id) {
        onTestFinished(() => {
          spawnSync("docker", ["rm", "-f", "-v", id], { encoding: "utf8" });
        });
      }
      expect(run.status).toBe(0);
      const next = startChild({});
      await next.output;
      await next.exited;
      expect(containersForPid(deadPid)).toEqual([id.slice(0, 12)]);
    }, 90_000);
  },
);
