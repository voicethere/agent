process.on("message", (message) => {
  if (message?.type === "session_start") {
    throw new Error("intentional crash");
  }
});
