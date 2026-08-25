/**
 * Inbound webhook handler — verify HMAC on raw bytes, then parse JSON and fan out.
 *
 * VoiceThere forwards the exact inbound body over IPC. Verify the custom
 * `x-agent-webhook-signature` header (hex HMAC-SHA256 of the raw body) using
 * `AGENT_WEBHOOK_SIGNING_SECRET` **before** `JSON.parse`.
 *
 * Build:
 *   npx @voicethere/agent build --entry templates/webhooks.ts --outfile dist/agent.js
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import {
  agentLog,
  broadcastToClients,
  defineAgent,
  speak,
} from "@voicethere/agent";

/** Custom header carrying hex HMAC-SHA256 of the raw webhook body. */
const WEBHOOK_SIGNATURE_HEADER = "x-agent-webhook-signature";

const connectedSessions = new Set<string>();

function verifyWebhookSignature(
  body: Buffer,
  headers: Record<string, string>,
  secret: string,
): boolean {
  const received =
    headers[WEBHOOK_SIGNATURE_HEADER] ??
    headers[WEBHOOK_SIGNATURE_HEADER.toUpperCase()];
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

    // Verify on raw bytes before JSON.parse — never parse untrusted payloads first.
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

    const record =
      payload && typeof payload === "object"
        ? (payload as { type?: string; text?: string })
        : null;
    const messageType = record?.type ?? "webhook";
    const text =
      typeof record?.text === "string" && record.text.trim()
        ? record.text.trim()
        : `webhook:${messageType}`;

    const sessionIds = [...connectedSessions];
    if (sessionIds.length === 0) {
      agentLog("info", `webhook verified with no live sessions eventId=${ctx.eventId}`);
      return;
    }

    broadcastToClients(
      {
        type: "webhook_event",
        eventId: ctx.eventId,
        path: ctx.path,
        payload,
      },
      sessionIds,
    );

    for (const sessionId of sessionIds) {
      speak(sessionId, text);
    }

    agentLog(
      "info",
      `webhook delivered to ${sessionIds.length} session(s) eventId=${ctx.eventId}`,
    );
  },
});
