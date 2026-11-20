// Child for binary-send-copy.test.ts: sends a scratch Buffer over fork IPC the
// way runtime.ts sendParentMessage does (process.send, no copy), then mutates
// the scratch at once. The parent checks which bytes arrived.
const scratch = Buffer.alloc(64, 0x11);
process.send({ type: "send_binary_to_client", sessionId: "s", data: scratch });
scratch.fill(0xff);
process.send({ type: "send_binary_to_client", sessionId: "s", data: scratch });
process.send({ type: "done" }, () => process.disconnect());
