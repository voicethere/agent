/**
 * Minimal IPC echo agent for sandbox integration tests (no SDK bundle).
 */
process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "session_start") {
    process.send?.({
      type: "log",
      level: "info",
      message: `started:${message.sessionId}`,
    });
  }
  if (
    message.type === "speech_event" &&
    message.event?.type === "user_speech_final" &&
    typeof message.event.text === "string" &&
    message.event.text.trim()
  ) {
    process.send?.({
      type: "speak",
      sessionId: message.sessionId,
      text: `echo:${message.event.text.trim()}`,
    });
  }
});
