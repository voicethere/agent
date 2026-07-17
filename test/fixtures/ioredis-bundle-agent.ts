/**
 * Minimal bundled ioredis agent for sandbox integration tests.
 * Connects in onAgentStart and logs IOREDIS_BUNDLE_OK via agentLog.
 */
import Redis from "ioredis";

import { agentLog, defineAgent } from "../../src/runtime.js";

defineAgent({
  async onAgentStart() {
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
    await redis.connect();
    const pong = await redis.ping();
    if (pong !== "PONG") {
      throw new Error(`unexpected ping reply: ${pong}`);
    }
    agentLog("info", "IOREDIS_BUNDLE_OK");
    redis.disconnect();
  },
});
