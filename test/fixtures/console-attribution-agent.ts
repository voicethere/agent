/**
 * Bundled agent for console attribution tests: two sessions interleave in one
 * child, each logging through plain `console.log`.
 */
import { defineAgent } from "../../src/runtime.js";

console.log("attr-module");

let resolveBLogged: () => void = () => {};
const bLogged = new Promise<void>((resolve) => {
  resolveBLogged = resolve;
});

defineAgent({
  async onSessionStart(ctx) {
    if (ctx.sessionId === "A") {
      console.log("A-1");
      setTimeout(() => console.log("A-timer"), 0);
      await bLogged;
      console.log("A-2");
    } else if (ctx.sessionId === "B") {
      console.log("B-1");
      resolveBLogged();
    }
  },
});
