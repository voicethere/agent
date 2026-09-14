export type RoomPeer = {
  id: string;
  x: number;
  z: number;
  yawDeg: number;
  muted: boolean;
};

export const MAX_ROOM_PEERS = 8;

type PeerPose = {
  x: number;
  z: number;
  yawDeg: number;
};

/** In-memory proximity room — pure TS, no agent runtime imports. */
export class ProximityRoom {
  private readonly members = new Map<string, PeerPose>();
  private readonly listenerMutes = new Map<string, Map<string, boolean>>();

  join(sessionId: string): "ok" | "full" {
    if (this.members.has(sessionId)) {
      return "ok";
    }
    if (this.members.size >= MAX_ROOM_PEERS) {
      return "full";
    }
    this.members.set(sessionId, { x: 0, z: 0, yawDeg: 0 });
    return "ok";
  }

  leave(sessionId: string): void {
    this.members.delete(sessionId);
    this.listenerMutes.delete(sessionId);
    for (const targets of this.listenerMutes.values()) {
      targets.delete(sessionId);
    }
  }

  setPose(sessionId: string, x: number, z: number, yawDeg: number): void {
    const peer = this.members.get(sessionId);
    if (!peer) {
      return;
    }
    peer.x = x;
    peer.z = z;
    peer.yawDeg = yawDeg;
  }

  snapshot(): RoomPeer[] {
    return [...this.members.entries()].map(([id, pose]) => ({
      id,
      x: pose.x,
      z: pose.z,
      yawDeg: pose.yawDeg,
      muted: this.isPeerMutedByAnyone(id),
    }));
  }

  setPeerMuted(listenerId: string, targetId: string, muted: boolean): void {
    let targets = this.listenerMutes.get(listenerId);
    if (!targets) {
      targets = new Map();
      this.listenerMutes.set(listenerId, targets);
    }
    targets.set(targetId, muted);
  }

  private isPeerMutedByAnyone(targetId: string): boolean {
    for (const targets of this.listenerMutes.values()) {
      if (targets.get(targetId)) {
        return true;
      }
    }
    return false;
  }

  clear(): void {
    this.members.clear();
    this.listenerMutes.clear();
  }
}
