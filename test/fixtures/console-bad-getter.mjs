/**
 * Installs misbehaving session getters, then logs through console.
 */
const KEY = Symbol.for("voicethere.agent.currentSessionId");

globalThis[KEY] = () => {
  throw new Error("boom");
};
console.log("throwing-getter");

globalThis[KEY] = () => 42;
console.log("non-string-getter");
