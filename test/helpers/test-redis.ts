import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomInt } from "node:crypto";
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

async function spawnDockerRedis(): Promise<{
  url: string;
  containerId: string;
} | null> {
  const port = 30_000 + randomInt(20_000);
  const started = spawnSync(
    "docker",
    ["run", "-d", "--rm", "-p", `127.0.0.1:${port}:6379`, "redis:7-alpine"],
    { encoding: "utf8" },
  );
  if (started.status !== 0) {
    return null;
  }
  const containerId = started.stdout.trim();
  if (!containerId) {
    return null;
  }
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
  spawnSync("docker", ["rm", "-f", containerId], { encoding: "utf8" });
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
 * Returns null when none of those work so callers can `skip`.
 */
let cached: Promise<TestRedis | null> | undefined;

export function openTestRedis(): Promise<TestRedis | null> {
  cached ??= (async () => {
    const urls = [
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

    const spawned = await spawnRedisServer();
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
              spawnSync("docker", ["rm", "-f", docker.containerId], {
                encoding: "utf8",
              });
            },
          };
        }
        spawnSync("docker", ["rm", "-f", docker.containerId], {
          encoding: "utf8",
        });
      }
    }

    return null;
  })();
  return cached;
}
