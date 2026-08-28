import { createServer, type Server, type Socket } from "node:net";

export type MiniRedis = {
  server: Server;
  port: number;
  close: () => Promise<void>;
};

/** Parse complete RESP array commands from a buffer; leave incomplete bytes in remainder. */
export function parseRespCommands(buffer: string): {
  commands: string[][];
  remainder: string;
} {
  const commands: string[][] = [];
  let i = 0;

  while (i < buffer.length) {
    if (buffer[i] !== "*") {
      break;
    }

    const commandStart = i;
    const countLineEnd = buffer.indexOf("\r\n", i);
    if (countLineEnd === -1) {
      break;
    }

    const argCount = Number.parseInt(buffer.slice(i + 1, countLineEnd), 10);
    if (!Number.isFinite(argCount) || argCount < 0) {
      break;
    }

    i = countLineEnd + 2;
    const args: string[] = [];
    let complete = true;

    for (let argIndex = 0; argIndex < argCount; argIndex += 1) {
      if (buffer[i] !== "$") {
        complete = false;
        break;
      }

      const lenLineEnd = buffer.indexOf("\r\n", i);
      if (lenLineEnd === -1) {
        complete = false;
        break;
      }

      const bulkLen = Number.parseInt(buffer.slice(i + 1, lenLineEnd), 10);
      if (!Number.isFinite(bulkLen) || bulkLen < 0) {
        complete = false;
        break;
      }

      i = lenLineEnd + 2;
      const dataEnd = i + bulkLen;
      if (buffer.length < dataEnd + 2) {
        complete = false;
        break;
      }

      if (buffer.slice(dataEnd, dataEnd + 2) !== "\r\n") {
        complete = false;
        break;
      }

      args.push(buffer.slice(i, dataEnd));
      i = dataEnd + 2;
    }

    if (!complete) {
      i = commandStart;
      break;
    }

    commands.push(args);
  }

  return { commands, remainder: buffer.slice(i) };
}

function replyForCommand(args: string[]): string {
  const command = args[0]?.toUpperCase() ?? "";

  switch (command) {
    case "PING":
      return "+PONG\r\n";
    case "INFO": {
      const body = "# Server\r\nredis_version:7.0.0\r\n";
      return `$${Buffer.byteLength(body)}\r\n${body}\r\n`;
    }
    case "AUTH":
    case "SELECT":
    case "CLIENT":
    case "QUIT":
      return "+OK\r\n";
    case "HELLO":
      return "-ERR unknown command\r\n";
    default:
      return "+OK\r\n";
  }
}

function handleSocketData(
  socket: Socket,
  chunk: Buffer,
  state: { buffer: string },
): void {
  state.buffer += chunk.toString("utf8");

  if (state.buffer.length > 8192) {
    socket.write("+OK\r\n");
    state.buffer = "";
    return;
  }

  const parsed = parseRespCommands(state.buffer);
  state.buffer = parsed.remainder;

  for (const args of parsed.commands) {
    socket.write(replyForCommand(args));
  }
}

/** Minimal RESP mock — one reply per complete command (handles pipelined HELLO+PING). */
export function startMiniRedis(): Promise<MiniRedis> {
  const sockets = new Set<Socket>();

  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));

      const state = { buffer: "" };
      socket.on("data", (chunk) => handleSocketData(socket, chunk, state));
    });

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to bind mini redis"));
        return;
      }

      resolve({
        server,
        port: address.port,
        close: () => closeMiniRedis(server, sockets),
      });
    });
  });
}

export function closeMiniRedis(
  server: Server,
  sockets: Set<Socket>,
  timeoutMs = 1000,
): Promise<void> {
  for (const socket of sockets) {
    socket.destroy();
  }
  sockets.clear();

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), timeoutMs);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
