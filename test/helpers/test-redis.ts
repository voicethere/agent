import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomInt } from "node:crypto";
import { hostname } from "node:os";
import { Redis } from "ioredis";

const CONNECT_TIMEOUT_MS = 400;

export type TestRedis = {
  redis: Redis;
  url: string;
  close: () => Promise<void>;
};

function configuredUrl(): string | undefined {
  const fromEnv =
    process.env.AGENT_TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
  return fromEnv || undefined;
}

function withDefaultDb(url: string, db: number): string {
  const parsed = new URL(url);
  if (parsed.pathname === "" || parsed.pathname === "/") {
    parsed.pathname = `/${db}`;
  }
  return parsed.toString();
}

function createClient(url: string): Redis {
  const redis = new Redis(url, {
    lazyConnect: true,
    connectTimeout: CONNECT_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
  redis.on("error", () => {
    /* probe / teardown: refuse and reset are expected */
  });
  return redis;
}

async function pingUrl(url: string): Promise<Redis | null> {
  const redis = createClient(url);
  try {
    await redis.connect();
    const pong = await redis.ping();
    if (pong !== "PONG") {
      redis.disconnect();
      return null;
    }
    return redis;
  } catch {
    redis.disconnect();
    return null;
  }
}

async function spawnRedisServer(): Promise<{
  url: string;
  child: ChildProcess;
} | null> {
  const port = 30_000 + randomInt(20_000);
  const child = spawn(
    "redis-server",
    [
      "--bind",
      "127.0.0.1",
      "--port",
      String(port),
      "--save",
      "",
      "--appendonly",
      "no",
      "--protected-mode",
      "no",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const ready = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 2_000);
    const onData = (chunk: Buffer) => {
      if (chunk.toString("utf8").includes("Ready to accept connections")) {
        clearTimeout(timer);
        resolve(true);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });

  if (!ready) {
    child.kill("SIGKILL");
    return null;
  }

  return { url: `redis://127.0.0.1:${port}/15`, child };
}

const DOCKER_LABEL = "voicethere-agent-test";
const DOCKER_PID_LABEL = "voicethere-agent-test-pid";
const DOCKER_HOST_LABEL = "voicethere-agent-test-host";

/** Containers this process started and has not yet removed. */
const ownContainers = new Set<string>();
let exitHooksInstalled = false;

function removeOwnContainers(): void {
  for (const id of ownContainers) {
    spawnSync("docker", ["rm", "-f", "-v", id], { encoding: "utf8" });
  }
  ownContainers.clear();
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Remove containers a crashed or killed earlier run left behind. Only
 * containers carrying our label whose recorded pid is gone are touched.
 */
function removeStaleContainers(): void {
  const listed = spawnSync(
    "docker",
    [
      "ps",
      "-a",
      "--no-trunc",
      "--filter",
      `label=${DOCKER_LABEL}=1`,
      "--format",
      `{{.ID}} {{.Label "${DOCKER_PID_LABEL}"}} {{.Label "${DOCKER_HOST_LABEL}"}}`,
    ],
    { encoding: "utf8" },
  );
  if (listed.status !== 0) return;
  for (const line of listed.stdout.split("\n")) {
    const [id, pidText, host] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    // A pid from another host or pid namespace (a devcontainer sharing the
    // Docker socket) says nothing about liveness here: never reap it.
    if (host !== hostname()) continue;
    if (!id || !Number.isInteger(pid) || pid <= 0 || pidAlive(pid)) continue;
    spawnSync("docker", ["rm", "-f", "-v", id], { encoding: "utf8" });
  }
}

function installExitHooks(): void {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  process.once("exit", removeOwnContainers);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const handler = () => {
      removeOwnContainers();
      process.removeListener(signal, handler);
      // Re-raise so the default signal semantics (exit by signal) still apply.
      process.kill(process.pid, signal);
    };
    process.on(signal, handler);
  }
}

async function spawnDockerRedis(): Promise<{
  url: string;
  containerId: string;
} | null> {
  removeStaleContainers();
  // A random host port can already be taken (other runs, leaked containers):
  // retry with a new port instead of giving up on the first refusal.
  let port = 0;
  let started = spawnSync("true", { encoding: "utf8" });
  for (let attempt = 0; attempt < 5; attempt++) {
    port = 30_000 + randomInt(20_000);
    started = spawnSync(
      "docker",
      [
        "run",
        "-d",
        "--rm",
        "--name",
        `${DOCKER_LABEL}-redis-${process.pid}-${port}`,
        "--label",
        `${DOCKER_LABEL}=1`,
        "--label",
        `${DOCKER_PID_LABEL}=${process.pid}`,
        "--label",
        `${DOCKER_HOST_LABEL}=${hostname()}`,
        "-p",
        `127.0.0.1:${port}:6379`,
        "redis:7-alpine",
      ],
      { encoding: "utf8" },
    );
    if (started.status === 0) break;
  }
  if (started.status !== 0) {
    return null;
  }
  const containerId = started.stdout.trim();
  if (!containerId) {
    return null;
  }
  ownContainers.add(containerId);
  installExitHooks();
  const url = `redis://127.0.0.1:${port}/15`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const redis = await pingUrl(url);
    if (redis) {
      redis.disconnect();
      return { url, containerId };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  spawnSync("docker", ["rm", "-f", "-v", containerId], { encoding: "utf8" });
  ownContainers.delete(containerId);
  return null;
}

/**
 * Real Redis for Lua / world-blob tests.
 *
 * Resolution order:
 * 1. `AGENT_TEST_REDIS_URL` or `REDIS_URL` (db defaults to 15 when omitted)
 * 2. `redis://127.0.0.1:6379/15` if a server is already listening
 * 3. Spawn `redis-server` on a random port when the binary is on PATH
 * 4. `docker run redis:7-alpine` when Docker is on PATH (set `AGENT_TEST_REDIS_DOCKER=0` to disable)
 *
 * `AGENT_TEST_REDIS_FORCE_DOCKER=1` skips 1-3 (used by the leak test).
 * The docker container is labelled with this process's pid and removed on
 * exit or SIGINT/SIGTERM/SIGHUP even when the caller never calls `close()`;
 * containers of dead pids carrying the label are removed on the next spawn.
 *
 * Returns null when none of those work so callers can `skip`.
 */
let cached: Promise<TestRedis | null> | undefined;

export function openTestRedis(): Promise<TestRedis | null> {
  cached ??= (async () => {
    const forceDocker = process.env.AGENT_TEST_REDIS_FORCE_DOCKER === "1";
    const urls = forceDocker
      ? []
      : [
          configuredUrl() ? withDefaultDb(configuredUrl()!, 15) : undefined,
          "redis://127.0.0.1:6379/15",
        ].filter((url): url is string => Boolean(url));

    const seen = new Set<string>();
    for (const url of urls) {
      if (seen.has(url)) continue;
      seen.add(url);
      const redis = await pingUrl(url);
      if (redis) {
        return {
          redis,
          url,
          close: async () => {
            redis.disconnect();
          },
        };
      }
    }

    const spawned = forceDocker ? null : await spawnRedisServer();
    if (spawned) {
      const redis = await pingUrl(spawned.url);
      if (redis) {
        return {
          redis,
          url: spawned.url,
          close: async () => {
            redis.disconnect();
            spawned.child.kill("SIGKILL");
          },
        };
      }
      spawned.child.kill("SIGKILL");
    }

    if (process.env.AGENT_TEST_REDIS_DOCKER !== "0") {
      const docker = await spawnDockerRedis();
      if (docker) {
        const redis = await pingUrl(docker.url);
        if (redis) {
          return {
            redis,
            url: docker.url,
            close: async () => {
              redis.disconnect();
              spawnSync("docker", ["rm", "-f", "-v", docker.containerId], {
                encoding: "utf8",
              });
              ownContainers.delete(docker.containerId);
            },
          };
        }
        spawnSync("docker", ["rm", "-f", "-v", docker.containerId], {
          encoding: "utf8",
        });
        ownContainers.delete(docker.containerId);
      }
    }

    return null;
  })();
  return cached;
}
