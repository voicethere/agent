import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileFlow, FlowSession } from "../../src/flow/core/index.js";
import { createNodeEffects } from "../../src/flow/effects-node.js";
import { installAgentIpc } from "../helpers/agent-ipc.js";

const SECRET = "s3cr3t-token-value";
const model = { provider: "openrouter", model: "m", apiKeySecret: "AGENT_K" };

let server: Server;
let base = "";
const sockets = new Set<Socket>();
let lastAuth: string | undefined;
let lastBody: string | undefined;

let restoreIpc: () => void = () => {};

beforeAll(async () => {
  restoreIpc = installAgentIpc().restore;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      lastAuth = req.headers.authorization;
      lastBody = Buffer.concat(chunks).toString("utf8");
      switch (req.url) {
        case "/ok":
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ data: { balance: 42 } }));
          return;
        case "/missing":
          res.statusCode = 404;
          res.end("{}");
          return;
        case "/redirect":
          res.statusCode = 302;
          res.setHeader("location", "http://127.0.0.1:1/x");
          res.end();
          return;
        case "/big":
          res.end("x".repeat(70 * 1024));
          return;
        case "/hang":
          return;
        default:
          res.statusCode = 500;
          res.end("?");
      }
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  restoreIpc();
  for (const s of sockets) s.destroy();
  await new Promise<void>((r) => server.close(() => r()));
});

function flow(path: string, timeoutMs?: number): any {
  return {
    version: 1,
    start: "call",
    models: { default: model },
    secrets: ["AGENT_T"],
    nodes: [
      {
        id: "call",
        type: "http",
        method: "POST",
        url: `${base}${path}`,
        headers: { Authorization: { secret: "AGENT_T", prefix: "Bearer " } },
        body: { q: 1 },
        map: { balance: "/data/balance" },
        ...(timeoutMs ? { timeoutMs } : {}),
        next: "ok",
        onError: "bad",
      },
      { id: "ok", type: "end", reason: "ok" },
      { id: "bad", type: "end", reason: "bad" },
    ],
  };
}

async function run(path: string, env: Record<string, string> = {}, t?: number) {
  const logs: { message: string; fields: Record<string, unknown> }[] = [];
  const ends: string[] = [];
  const effects = createNodeEffects({
    sessionId: "s1",
    env: { AGENT_T: SECRET, ...env },
    providerFor: () => {
      throw new Error("unused");
    },
    log: (_l, message, fields) => logs.push({ message, fields }),
  });
  const orig = effects.end.bind(effects);
  effects.end = (reason) => {
    ends.push(reason);
    orig(reason);
  };
  const s = new FlowSession(compileFlow(flow(path, t)), effects, {
    sessionId: "s1",
    channel: "voice",
  });
  await s.start();
  return { s, logs, ends };
}

describe("http node against a local server", () => {
  it("200 + map; sends the Bearer secret and the JSON body", async () => {
    const r = await run("/ok");
    expect(r.s.variables["balance"]).toBe(42);
    expect(r.s.variables["call.status"]).toBe(200);
    expect(r.ends).toEqual(["ok"]);
    expect(lastAuth).toBe(`Bearer ${SECRET}`);
    expect(JSON.parse(lastBody!)).toEqual({ q: 1 });
    expect(JSON.stringify(r.logs)).not.toContain(SECRET);
    expect(r.logs.some((l) => l.message === "flow_step")).toBe(true);
  });

  it("404 -> HTTP_404", async () => {
    const r = await run("/missing");
    expect(r.s.variables["error.call"]).toBe("HTTP_404");
    expect(r.ends).toEqual(["bad"]);
  });

  it("hang -> HTTP_TIMEOUT", async () => {
    const r = await run("/hang", {}, 150);
    expect(r.s.variables["error.call"]).toBe("HTTP_TIMEOUT");
    expect(r.ends).toEqual(["bad"]);
  });

  it("302 -> HTTP_REDIRECT_BLOCKED", async () => {
    const r = await run("/redirect");
    expect(r.s.variables["error.call"]).toBe("HTTP_REDIRECT_BLOCKED");
  });

  it("70 KiB -> HTTP_RESPONSE_TOO_LARGE", async () => {
    const r = await run("/big");
    expect(r.s.variables["error.call"]).toBe("HTTP_RESPONSE_TOO_LARGE");
  });

  it("a missing secret -> FLOW_SECRET_MISSING and no request is sent", async () => {
    lastAuth = "untouched";
    const r = await run("/ok", { AGENT_T: "" });
    expect(r.s.variables["error.call"]).toBe("FLOW_SECRET_MISSING");
    expect(lastAuth).toBe("untouched");
  });

  it("a closed port -> HTTP_NETWORK", async () => {
    const r = await run("/ok", {}, 2000).then(async () => {
      const f = flow("/ok");
      f.nodes[0].url = "http://127.0.0.1:1/x";
      const ends: string[] = [];
      const effects = createNodeEffects({
        sessionId: "s1",
        env: { AGENT_T: SECRET },
        providerFor: () => {
          throw new Error("unused");
        },
        log: () => {},
      });
      effects.end = (reason) => ends.push(reason);
      const s = new FlowSession(compileFlow(f), effects, {
        sessionId: "s1",
        channel: "voice",
      });
      await s.start();
      return { s, ends };
    });
    expect(r.s.variables["error.call"]).toBe("HTTP_NETWORK");
    expect(r.ends).toEqual(["bad"]);
  });
});
