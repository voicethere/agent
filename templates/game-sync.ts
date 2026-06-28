/**
 * Multiplayer object-sync template with ownership checks.
 *
 * World layout:
 * - one global Float32Array
 * - each tracked object uses exactly 9 floats:
 *   [objectId, posX, posY, posZ, posW, dirX, dirY, dirZ, dirW]
 *
 * Control messages:
 * - `{ type: "register" }` -> allocates (or reuses) one 9-float slot
 * - server replies `{ type: "register_ack", objectId }`
 *
 * Simulation:
 * - server-authoritative movement at 60Hz
 * - wall bounce + object-object elastic collisions on server
 * - clients render server snapshots; client binary writes are ignored
 *
 * Broadcast:
 * - 60Hz world-state broadcast starts when at least 1 client is connected
 * - stops when connected client count drops below 1
 *
 * Build:
 *   npx @voicethere/agent build --entry templates/game-sync.ts
 */
import {
    agentLog,
    defineAgent,
    sendBinaryToClient,
    sendToClient,
} from "@voicethere/agent";

const OBJECT_STRIDE = 9;
const BROADCAST_HZ = 60;
const BROADCAST_INTERVAL_MS = Math.floor(1000 / BROADCAST_HZ);
const BOARD_WIDTH = 1280;
const BOARD_HEIGHT = 720;
const OBJECT_RADIUS = 25;
const MIN_SPEED = 90;
const MAX_SPEED = 180;
const COLLISION_RESTITUTION = 1.0;

const connectedSessions = new Set<string>();
const objectOwners = new Map<number, string>(); // objectId -> sessionId
const sessionObjects = new Map<string, Set<number>>(); // sessionId -> owned objectIds
// Slots we can recycle. Keeping a free-list avoids unbounded array growth when
// clients churn (join/leave repeatedly).
const freeSlots: number[] = [];

let worldState = new Float32Array(0);
let broadcastTimer: NodeJS.Timeout | null = null;

interface TrackedObjectInfo {
    objectId: number;
    ownerSessionId: string;
}

function rand(min: number, max: number): number {
    return min + Math.random() * (max - min);
}

function randomVelocity(): number {
    return (Math.random() < 0.5 ? -1 : 1) * rand(MIN_SPEED, MAX_SPEED);
}

function slotToObjectId(slot: number): number {
    // Object ids are 1-based so 0 can represent "unused".
    return slot + 1;
}

function objectIdToSlot(objectId: number): number {
    // Inverse of slotToObjectId().
    return objectId - 1;
}

function markSlotFree(slot: number): void {
    // Zero the entire record. Slot is still allocated in array length terms,
    // but logically available for reuse.
    const start = slot * OBJECT_STRIDE;
    for (let i = 0; i < OBJECT_STRIDE; i += 1) {
        worldState[start + i] = 0;
    }
}

function allocateSlot(): number {
    // Prefer recycling old slots before growing worldState.
    const reused = freeSlots.shift();
    if (reused !== undefined) return reused;

    // Grow by exactly one object record (9 floats).
    const next = new Float32Array(worldState.length + OBJECT_STRIDE);
    next.set(worldState);
    worldState = next;
    return worldState.length / OBJECT_STRIDE - 1;
}

function attachObjectToSession(sessionId: string, objectId: number): void {
    // Tracks ownership in both directions so validation and cleanup are O(1).
    let owned = sessionObjects.get(sessionId);
    if (!owned) {
        owned = new Set<number>();
        sessionObjects.set(sessionId, owned);
    }
    owned.add(objectId);
    objectOwners.set(objectId, sessionId);
}

function releaseObject(objectId: number): void {
    // Remove reverse-ownership references first.
    const owner = objectOwners.get(objectId);
    if (owner) {
        const owned = sessionObjects.get(owner);
        owned?.delete(objectId);
        if (owned && owned.size === 0) {
            sessionObjects.delete(owner);
        }
    }

    objectOwners.delete(objectId);

    const slot = objectIdToSlot(objectId);
    if (slot < 0) return;
    if (slot >= worldState.length / OBJECT_STRIDE) return;

    // Free slot contents and push slot into free-list for future register() calls.
    markSlotFree(slot);
    if (!freeSlots.includes(slot)) {
        freeSlots.push(slot);
        freeSlots.sort((a, b) => a - b);
    }
}

function registerObject(sessionId: string): number {
    // Allocate (or reuse) one slot and stamp object id plus initial state.
    const slot = allocateSlot();
    const objectId = slotToObjectId(slot);
    const start = slot * OBJECT_STRIDE;
    worldState[start] = objectId;
    worldState[start + 1] = rand(OBJECT_RADIUS, BOARD_WIDTH - OBJECT_RADIUS);
    worldState[start + 2] = rand(OBJECT_RADIUS, BOARD_HEIGHT - OBJECT_RADIUS);
    worldState[start + 3] = 0;
    worldState[start + 4] = 1;
    worldState[start + 5] = randomVelocity();
    worldState[start + 6] = randomVelocity();
    worldState[start + 7] = 0;
    worldState[start + 8] = 0;
    attachObjectToSession(sessionId, objectId);
    return objectId;
}

function parseRegisterCommand(message: unknown): boolean {
    if (!message || typeof message !== "object") return false;
    const record = message as { type?: unknown };
    return record.type === "register";
}

function parseChatCommand(
    message: unknown,
): { text: string } | null {
    if (!message || typeof message !== "object") return null;
    const record = message as { type?: unknown; text?: unknown };
    if (record.type !== "chat" || typeof record.text !== "string") return null;
    const text = record.text.trim();
    if (!text) return null;
    return {text};
}

function trackedObjectsSnapshot(): TrackedObjectInfo[] {
    const objects: TrackedObjectInfo[] = [];
    for (const [objectId, ownerSessionId] of objectOwners) {
        objects.push({objectId, ownerSessionId});
    }
    objects.sort((a, b) => a.objectId - b.objectId);
    return objects;
}

function notifyObjectRegistered(objectId: number, ownerSessionId: string): void {
    for (const sessionId of connectedSessions) {
        if (sessionId === ownerSessionId) continue;
        sendToClient(sessionId, {
            type: "object_registered",
            objectId,
            ownerSessionId,
        });
    }
}

function notifyObjectReleased(objectId: number, ownerSessionId: string): void {
    for (const sessionId of connectedSessions) {
        if (sessionId === ownerSessionId) continue;
        sendToClient(sessionId, {
            type: "object_released",
            objectId,
            ownerSessionId,
        });
    }
}

function broadcastWorldState(): void {
    if (connectedSessions.size === 0) return;
    // Copy to a detached buffer so downstream sends cannot observe mutations
    // from subsequent writes in the same event loop tick.
    const payload = Buffer.from(worldState.buffer.slice(0));
    for (const sessionId of connectedSessions) {
        sendBinaryToClient(sessionId, payload, "sync");
    }
}

function simulateWorldStep(dtSec: number): void {
    const activeObjectIds = [...objectOwners.keys()];
    for (const objectId of activeObjectIds) {
        const slot = objectIdToSlot(objectId);
        const start = slot * OBJECT_STRIDE;
        if (start < 0 || start + OBJECT_STRIDE > worldState.length) continue;

        let x = worldState[start + 1] ?? 0;
        let y = worldState[start + 2] ?? 0;
        let vx = worldState[start + 5] ?? 0;
        let vy = worldState[start + 6] ?? 0;

        x += vx * dtSec;
        y += vy * dtSec;

        if (x < OBJECT_RADIUS || x > BOARD_WIDTH - OBJECT_RADIUS) {
            vx *= -1;
            x = Math.max(OBJECT_RADIUS, Math.min(BOARD_WIDTH - OBJECT_RADIUS, x));
        }
        if (y < OBJECT_RADIUS || y > BOARD_HEIGHT - OBJECT_RADIUS) {
            vy *= -1;
            y = Math.max(OBJECT_RADIUS, Math.min(BOARD_HEIGHT - OBJECT_RADIUS, y));
        }

        worldState[start + 1] = x;
        worldState[start + 2] = y;
        worldState[start + 5] = vx;
        worldState[start + 6] = vy;
    }

    for (let i = 0; i < activeObjectIds.length; i += 1) {
        const aId = activeObjectIds[i];
        const aSlot = objectIdToSlot(aId);
        const aStart = aSlot * OBJECT_STRIDE;
        if (aStart < 0 || aStart + OBJECT_STRIDE > worldState.length) continue;
        for (let j = i + 1; j < activeObjectIds.length; j += 1) {
            const bId = activeObjectIds[j];
            const bSlot = objectIdToSlot(bId);
            const bStart = bSlot * OBJECT_STRIDE;
            if (bStart < 0 || bStart + OBJECT_STRIDE > worldState.length) continue;

            let ax = worldState[aStart + 1] ?? 0;
            let ay = worldState[aStart + 2] ?? 0;
            let avx = worldState[aStart + 5] ?? 0;
            let avy = worldState[aStart + 6] ?? 0;
            let bx = worldState[bStart + 1] ?? 0;
            let by = worldState[bStart + 2] ?? 0;
            let bvx = worldState[bStart + 5] ?? 0;
            let bvy = worldState[bStart + 6] ?? 0;

            let dx = bx - ax;
            let dy = by - ay;
            let distSq = dx * dx + dy * dy;
            const minDist = OBJECT_RADIUS * 2;
            const minDistSq = minDist * minDist;
            if (!(distSq > 0 && distSq < minDistSq)) continue;

            let dist = Math.sqrt(distSq);
            if (dist === 0) {
                // Deterministic fallback axis when centers overlap exactly.
                dx = 1;
                dy = 0;
                dist = 1;
                distSq = 1;
            }
            const nx = dx / dist;
            const ny = dy / dist;

            // Positional correction prevents objects from remaining overlapped.
            const overlap = minDist - dist;
            const half = overlap * 0.5;
            ax -= nx * half;
            ay -= ny * half;
            bx += nx * half;
            by += ny * half;

            const rvx = bvx - avx;
            const rvy = bvy - avy;
            const velAlongNormal = rvx * nx + rvy * ny;
            if (velAlongNormal < 0) {
                const impulse = (-(1 + COLLISION_RESTITUTION) * velAlongNormal) / 2;
                avx -= impulse * nx;
                avy -= impulse * ny;
                bvx += impulse * nx;
                bvy += impulse * ny;
            }

            worldState[aStart + 1] = Math.max(OBJECT_RADIUS, Math.min(BOARD_WIDTH - OBJECT_RADIUS, ax));
            worldState[aStart + 2] = Math.max(OBJECT_RADIUS, Math.min(BOARD_HEIGHT - OBJECT_RADIUS, ay));
            worldState[aStart + 5] = avx;
            worldState[aStart + 6] = avy;
            worldState[bStart + 1] = Math.max(OBJECT_RADIUS, Math.min(BOARD_WIDTH - OBJECT_RADIUS, bx));
            worldState[bStart + 2] = Math.max(OBJECT_RADIUS, Math.min(BOARD_HEIGHT - OBJECT_RADIUS, by));
            worldState[bStart + 5] = bvx;
            worldState[bStart + 6] = bvy;
        }
    }
}

function startBroadcastLoopIfNeeded(): void {
    if (broadcastTimer) return;
    if (connectedSessions.size < 1) return;

    broadcastTimer = setInterval(() => {
        if (connectedSessions.size < 1) {
            if (broadcastTimer) {
                clearInterval(broadcastTimer);
                broadcastTimer = null;
            }
            return;
        }
        simulateWorldStep(1 / BROADCAST_HZ);
        broadcastWorldState();
    }, BROADCAST_INTERVAL_MS);

    agentLog("info", `world loop started (${BROADCAST_HZ}Hz)`);
}

function stopBroadcastLoopIfNeeded(): void {
    if (connectedSessions.size >= 1) return;
    if (!broadcastTimer) return;
    clearInterval(broadcastTimer);
    broadcastTimer = null;
    agentLog("info", "world loop stopped");
}

defineAgent({
    onClientJoin({sessionId}) {
        connectedSessions.add(sessionId);
        startBroadcastLoopIfNeeded();
        // New client receives the current ownership map so it can assign stable
        // colors per owner and immediately render known tracked objects.
        sendToClient(sessionId, {
            type: "world_snapshot",
            objects: trackedObjectsSnapshot(),
        });
        agentLog("info", `join ${sessionId} connected=${connectedSessions.size}`);
    },

    onClientLeave({sessionId}) {
        connectedSessions.delete(sessionId);

        const owned = sessionObjects.get(sessionId);
        if (owned) {
            for (const objectId of [...owned]) {
                notifyObjectReleased(objectId, sessionId);
                releaseObject(objectId);
            }
            sessionObjects.delete(sessionId);
        }

        stopBroadcastLoopIfNeeded();
        agentLog(
            "info",
            `leave ${sessionId} connected=${connectedSessions.size} worldFloats=${worldState.length} freeSlots=${freeSlots.length}`,
        );
    },

    onDataChannelMessage(ctx) {
        // Register is a control-plane message over JSON data channel.
        // Binary channel is reserved for high-frequency state deltas.
        if (parseRegisterCommand(ctx.message)) {
            const objectId = registerObject(ctx.sessionId);
            sendToClient(ctx.sessionId, {type: "register_ack", objectId});
            notifyObjectRegistered(objectId, ctx.sessionId);
            agentLog("info", `register session=${ctx.sessionId} objectId=${objectId}`);
            return;
        }

        // Optional chat mode for debugging/coordinating live test sessions.
        const chat = parseChatCommand(ctx.message);
        if (!chat) return;
        for (const sessionId of connectedSessions) {
            sendToClient(sessionId, {
                type: "chat_broadcast",
                senderSessionId: ctx.sessionId,
                text: chat.text,
            });
        }
    },

    onDataChannelBinary(ctx) {
        // Server-authoritative simulation: ignore client binary state writes.
        // Keeping the hook makes intent-based controls easy to add later.
        void ctx;
    },
});
