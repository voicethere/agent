"use strict";
/**
 * Node process-warning forwarder for the sandboxed customer child.
 *
 * Preloaded with `--require` (not `--import`) so it also sees the warnings Node emits
 * during bootstrap, such as the `--allow-net` experimental-flag warning. The child runs
 * with `--no-warnings`, so nothing reaches stderr; each warning goes to the parent over
 * IPC as `{ type: "node_warning", … }` instead.
 */
const MESSAGE_MAX = 2048;
const STACK_MAX = 4096;

process.on("warning", (w) => {
  try {
    if (typeof process.send !== "function" || !process.connected) return;
    const message = String(w?.message ?? "");
    const stack = typeof w?.stack === "string" ? w.stack : undefined;
    process.send(
      {
        type: "node_warning",
        name: String(w?.name ?? "Warning"),
        ...(typeof w?.code === "string" ? { code: w.code } : {}),
        message:
          message.length > MESSAGE_MAX
            ? message.slice(0, MESSAGE_MAX)
            : message,
        messageLength: message.length,
        ...(stack ? { stack: stack.slice(0, STACK_MAX) } : {}),
      },
      () => {},
    ); // callback swallows async send errors
  } catch {
    // Drop silently: never stderr (it would reach customer logs).
  }
});
