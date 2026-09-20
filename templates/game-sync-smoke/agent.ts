/**
 * Minimal data-channel agent for staging smokes (data-only / shared-child / idle).
 *
 * Protocol:
 * - On join/leave: broadcast `{ type: "state", tick, players }` to every session.
 * - On `{ type: "tick" }`: increment tick and rebroadcast.
 * - On `{ type: "agent_log_probe", id }`: `agentLog` the id (agent-logs-smoke) and ack.
 * - On `{ type: "env_probe", key }`: ack allowlisted `AGENT_E2E_*` keys from `process.env`.
 *
 * Load-staging uses the full `game-sync` product template (object-sync).
 */
import { agentLog, defineAgent, sendToClient } from "@voicethere/agent";

/** E2E deploy-smoke — rewritten before each fixture upload. */
export const FIXTURE_MARKER = "deploy-smoke-fixture-b";

/** Only keys matching this pattern may be read via env_probe (no webhook/OpenAI secrets). */
export const AGENT_E2E_ENV_PROBE_KEY_PATTERN = /^AGENT_E2E_[A-Z0-9_]+$/;

export function isAllowlistedEnvProbeKey(key: string): boolean {
  return AGENT_E2E_ENV_PROBE_KEY_PATTERN.test(key.trim());
}

export function resolveEnvProbeValue(key: string): string | null {
  const trimmed = key.trim();
  if (!isAllowlistedEnvProbeKey(trimmed)) {
    return null;
  }
  return process.env[trimmed] ?? null;
}

const connectedSessions = new Set<string>();
let tick = 0;

function broadcastState(): void {
  const players = connectedSessions.size;
  for (const sessionId of connectedSessions) {
    sendToClient(sessionId, {
      type: "state",
      tick,
      players,
      marker: FIXTURE_MARKER,
    });
  }
}

function isTickMessage(message: unknown): boolean {
  return (
    !!message &&
    typeof message === "object" &&
    (message as { type?: unknown }).type === "tick"
  );
}

function isAgentLogProbe(
  message: unknown,
): message is { type: "agent_log_probe"; id: string } {
  if (!message || typeof message !== "object") return false;
  const record = message as { type?: unknown; id?: unknown };
  return (
    record.type === "agent_log_probe" &&
    typeof record.id === "string" &&
    record.id.trim().length > 0
  );
}

function isEnvProbeMessage(
  message: unknown,
): message is { type: "env_probe"; key: string } {
  if (!message || typeof message !== "object") return false;
  const record = message as { type?: unknown; key?: unknown };
  return record.type === "env_probe" && typeof record.key === "string";
}

defineAgent({
  onClientJoin({ sessionId }) {
    connectedSessions.add(sessionId);
    broadcastState();
  },

  onClientLeave({ sessionId }) {
    connectedSessions.delete(sessionId);
    broadcastState();
  },

  onDataChannelMessage(ctx) {
    if (isAgentLogProbe(ctx.message)) {
      const id = ctx.message.id.trim();
      agentLog(
        "info",
        `agent-logs-e2e probe ${id}`,
        { probeId: id, e2e: "agent-logs-smoke" },
        ctx.sessionId,
      );
      sendToClient(ctx.sessionId, { type: "agent_log_probe_ack", id });
      return;
    }

    if (isEnvProbeMessage(ctx.message)) {
      const key = ctx.message.key.trim();
      sendToClient(ctx.sessionId, {
        type: "env_probe_ack",
        key,
        value: resolveEnvProbeValue(key),
      });
      return;
    }

    if (!isTickMessage(ctx.message)) {
      return;
    }
    tick += 1;
    broadcastState();
  },
});
