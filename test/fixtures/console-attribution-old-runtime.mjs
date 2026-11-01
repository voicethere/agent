/**
 * Plain ESM agent with no runtime import (no session getter installed).
 */
console.log("old-module");

process.on("message", (message) => {
  if (
    message &&
    typeof message === "object" &&
    message.type === "session_start"
  ) {
    console.log("old-handler");
  }
});
