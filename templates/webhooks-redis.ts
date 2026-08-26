/**
 * Inbound webhook + shared Redis counter — verify HMAC first, atomic Redis update, DC fan-out.
 *
 * Fan-out to connected sessions does not require Redis; Redis is for shared state across
 * runner pods (every child in the process still receives the webhook IPC).
 *
 * Verify `x-agent-webhook-signature` on the raw body with `AGENT_WEBHOOK_SIGNING_SECRET`
 * before `JSON.parse`. Atomic counter uses Redis Lua (read-modify-write in one round trip).
 *
 * Build:
 *   npx @voicethere/agent build --entry templates/webhooks-redis.ts --outfile dist/agent.js
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import Redis from "ioredis";

import {
  agentLog,
  broadcastToClients,
  defineAgent,
} from "@voicethere/agent";

const WEBHOOK_SIGNATURE_HEADER = "x-agent-webhook-signature";
const REDIS_COUNTER_KEY = "agent:webhook:event_count";

/** Atomic increment — safe under concurrent webhook delivery on one pod. */
const LUA_INCREMENT_COUNTER = `
local key = KEYS[1]
local n = redis.call('INCR', key)
return n
`;

const connectedSessions = new Set<string>();
let redis: Redis | null = null;

function getHeaderCaseInsensitive(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === want) {
      return value;
    }
  }
  return undefined;
}

function verifyWebhookSignature(
  body: Buffer,
  headers: Record<string, string>,
  secret: string,
): boolean {
  const received = getHeaderCaseInsensitive(headers, WEBHOOK_SIGNATURE_HEADER);
  if (!received?.trim()) {
    return false;
  }
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  try {
    const actual = Buffer.from(received.trim(), "hex");
    const want = Buffer.from(expected, "hex");
    return actual.length === want.length && timingSafeEqual(actual, want);
  } catch {
    return false;
  }
}

defineAgent({
  async onAgentStart({ env }) {
    const redisUrl = env.AGENT_REDIS_URL ?? process.env.AGENT_REDIS_URL;
    if (!redisUrl?.trim()) {
      agentLog(
        "warn",
        "AGENT_REDIS_URL unset — webhooks-redis uses in-memory sessions only",
      );
      return;
    }

    redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
    await redis.connect();
    agentLog("info", "webhooks-redis connected to project Redis");
  },

  onSessionStart({ sessionId }) {
    connectedSessions.add(sessionId);
  },

  onSessionEnd({ sessionId }) {
    connectedSessions.delete(sessionId);
  },

  async onWebhook(ctx) {
    const secret = process.env.AGENT_WEBHOOK_SIGNING_SECRET?.trim();
    if (!secret) {
      agentLog("warn", "webhook ignored: AGENT_WEBHOOK_SIGNING_SECRET unset");
      return;
    }

    // Verify on raw bytes before JSON.parse.
    if (!verifyWebhookSignature(ctx.body, ctx.headers, secret)) {
      agentLog("warn", `webhook signature invalid eventId=${ctx.eventId}`);
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(ctx.body.toString("utf8"));
    } catch {
      agentLog("warn", `webhook body is not JSON eventId=${ctx.eventId}`);
      return;
    }

    let eventCount: number | null = null;
    if (redis) {
      const result = await redis.eval(LUA_INCREMENT_COUNTER, 1, REDIS_COUNTER_KEY);
      eventCount = typeof result === "number" ? result : Number(result);
    }

    const sessionIds =
      ctx.sessionIds.length > 0 ? ctx.sessionIds : [...connectedSessions];
    if (sessionIds.length === 0) {
      agentLog(
        "info",
        `webhook verified (count=${eventCount ?? "n/a"}) with no live sessions`,
      );
      return;
    }

    broadcastToClients(
      {
        type: "webhook_event",
        eventId: ctx.eventId,
        path: ctx.path,
        eventCount,
        payload,
      },
      sessionIds,
    );

    agentLog(
      "info",
      `webhook fan-out to ${sessionIds.length} session(s) eventId=${ctx.eventId}`,
    );
  },
});
