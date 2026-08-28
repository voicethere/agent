import { connect } from "node:net";
import { describe, expect, it } from "vitest";

import { parseRespCommands, startMiniRedis } from "./mini-redis.js";

describe("mini-redis RESP parser", () => {
  it("parses a single PING command", () => {
    const parsed = parseRespCommands("*1\r\n$4\r\nPING\r\n");
    expect(parsed.commands).toEqual([["PING"]]);
    expect(parsed.remainder).toBe("");
  });

  it("keeps incomplete commands in the remainder", () => {
    const parsed = parseRespCommands("*1\r\n$4\r\nPI");
    expect(parsed.commands).toEqual([]);
    expect(parsed.remainder).toBe("*1\r\n$4\r\nPI");
  });

  it("parses pipelined HELLO then PING from one buffer", () => {
    const pipelined =
      "*2\r\n$5\r\nHELLO\r\n$3\r\n123\r\n" + "*1\r\n$4\r\nPING\r\n";
    const parsed = parseRespCommands(pipelined);
    expect(parsed.commands).toEqual([["HELLO", "123"], ["PING"]]);
    expect(parsed.remainder).toBe("");
  });
});

describe("mini-redis server", () => {
  it("replies to HELLO and PING written in one TCP chunk", async () => {
    const mini = await startMiniRedis();
    const pipelined =
      "*2\r\n$5\r\nHELLO\r\n$3\r\n123\r\n" + "*1\r\n$4\r\nPING\r\n";

    const replies = await new Promise<string>((resolve, reject) => {
      const socket = connect(mini.port, "127.0.0.1", () => {
        socket.write(pipelined);
      });

      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString("utf8");
        if (data.includes("PONG")) {
          socket.end();
        }
      });
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });

    expect(replies).toBe("-ERR unknown command\r\n+PONG\r\n");
    await mini.close();
  });
});
