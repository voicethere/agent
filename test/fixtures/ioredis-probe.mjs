/**
 * Sandbox probe: import ioredis and PING a REDIS_HOST:REDIS_PORT fixture.
 * Prints IOREDIS_OK / IOREDIS_FAIL for the parent test.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const agentRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const Redis = require(join(agentRoot, "node_modules/ioredis"));

const host = process.env.REDIS_HOST ?? "127.0.0.1";
const port = Number(process.env.REDIS_PORT ?? "6379");

const redis = new Redis({
  host,
  port,
  enableReadyCheck: false,
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  connectTimeout: 2000,
  retryStrategy: () => null,
});

try {
  await redis.connect();
  const pong = await redis.ping();
  if (pong !== "PONG") {
    throw new Error(`unexpected ping reply: ${pong}`);
  }
  process.stdout.write("IOREDIS_OK\n");
  redis.disconnect();
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
  process.stderr.write(`IOREDIS_FAIL ${code} ${message}\n`);
  try {
    redis.disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
}
