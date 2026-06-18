/**
 * Authoritative tick counter — shared child broadcasts `{ type: 'state', tick, players }`.
 *
 * Build:
 *   npx @voicethere/agent build --entry templates/game-sync.ts
 */
import {
  agentLog,
  broadcastToClients,
  defineAgent,
  sendToClient,
  type DataChannelContext,
} from "@voicethere/agent";

let tick = 0;
const connected = new Set<string>();

function playerCount(): number {
  return connected.size;
}

function broadcastState(excludeSessionId?: string): void {
  const payload = { type: "state" as const, tick, players: playerCount() };
  const targets = excludeSessionId
    ? [...connected].filter((id) => id !== excludeSessionId)
    : [...connected];
  broadcastToClients(payload, targets);
}

function handleTickMessage(ctx: DataChannelContext): void {
  const message = ctx.message;
  if (!message || typeof message !== "object") return;
  const record = message as { type?: string };
  if (record.type !== "tick") return;
  tick += 1;
  agentLog(
    "info",
    `tick=${tick} players=${playerCount()} from=${ctx.sessionId}`,
  );
  broadcastToClients({ type: "state", tick, players: playerCount() }, [
    ...connected,
  ]);
}

defineAgent({
  onClientJoin({ sessionId }) {
    connected.add(sessionId);
    sendToClient(sessionId, {
      type: "state",
      tick,
      players: playerCount(),
    });
    broadcastState(sessionId);
    agentLog("info", `join ${sessionId} players=${playerCount()}`);
  },

  onClientLeave({ sessionId }) {
    connected.delete(sessionId);
    broadcastToClients({ type: "state", tick, players: playerCount() }, [
      ...connected,
    ]);
    agentLog("info", `leave ${sessionId} players=${playerCount()}`);
  },

  onDataChannelMessage(ctx) {
    handleTickMessage(ctx);
  },
});
