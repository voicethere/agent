/**
 * Minimal data-channel agent for staging smokes (data-only / shared-child / idle).
 *
 * Protocol:
 * - On join/leave: broadcast `{ type: "state", tick, players }` to every session.
 * - On `{ type: "tick" }`: increment tick and rebroadcast.
 * - On `{ type: "agent_log_probe", id }`: `agentLog` the id (agent-logs-smoke) and ack.
 *
 * Load-staging uses the full `game-sync` product template (object-sync).
 */
import { agentLog, defineAgent, sendToClient } from "@voicethere/agent";

/** E2E deploy-smoke — rewritten before each fixture upload. */
export const FIXTURE_MARKER = "deploy-smoke-fixture-b";

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

    if (!isTickMessage(ctx.message)) {
      return;
    }
    tick += 1;
    broadcastState();
  },
});
