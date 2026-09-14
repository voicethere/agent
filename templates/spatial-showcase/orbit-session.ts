/** Orbit timer vs clock — split so pause/restart does not wipe elapsed time. */
export type OrbitSessionTimers = {
  orbitStartMs?: number;
  orbitTimer?: ReturnType<typeof setInterval>;
  lastOrbitPoseEmitMs?: number;
};

export function stopOrbitInterval(state: OrbitSessionTimers): void {
  if (state.orbitTimer) {
    clearInterval(state.orbitTimer);
    state.orbitTimer = undefined;
  }
}

export function resetOrbitSession(state: OrbitSessionTimers): void {
  stopOrbitInterval(state);
  state.orbitStartMs = undefined;
  state.lastOrbitPoseEmitMs = undefined;
}

export function beginOrbitClock(state: OrbitSessionTimers): void {
  state.orbitStartMs = Date.now();
  state.lastOrbitPoseEmitMs = undefined;
}
