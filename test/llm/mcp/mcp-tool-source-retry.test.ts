import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  McpToolSource,
  type McpLogFn,
} from "../../../src/llm/mcp/mcp-tool-source.js";
import { startTestMcpServer, type TestMcpServer } from "./mcp-test-server.js";

// A call that fails on a dropped connection (fetch rejects with `TypeError: fetch failed`, cause
// ECONNRESET) is retried once on the reconnected client, but only for tools the server marks
// read-only or idempotent (staging-full 45494156054: get_plan_price never reached the platform).

const sources: McpToolSource[] = [];
const servers: TestMcpServer[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(sources.splice(0).map((s) => s.close()));
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

function fetchFailed(): TypeError {
  const cause = Object.assign(new Error("read ECONNRESET"), {
    code: "ECONNRESET",
  });
  return new TypeError("fetch failed", { cause });
}

async function readySource(
  log?: McpLogFn,
  backoffMs = [20],
): Promise<{ src: McpToolSource; srv: TestMcpServer }> {
  const srv = await startTestMcpServer(0, { annotatedTools: true });
  servers.push(srv);
  const src = new McpToolSource({
    name: "t",
    url: srv.url,
    backoffMs,
    connectTimeoutMs: 1_000,
    log,
  });
  sources.push(src);
  src.start();
  expect(await src.ready(5_000)).toBe(true);
  return { src, srv };
}

/** The next client.callTool rejects like a dropped socket; later calls go to the server. */
function dropNextCall() {
  const original = Client.prototype.callTool;
  return vi
    .spyOn(Client.prototype, "callTool")
    .mockImplementationOnce(() => Promise.reject(fetchFailed()))
    .mockImplementation(function (this: Client, ...a) {
      return original.apply(this, a);
    });
}

describe("McpToolSource retry after a dropped connection", () => {
  it("read-only tool: the call is sent again on the new connection (2 calls)", async () => {
    const { src } = await readySource();
    const spy = dropNextCall();
    const res = await src.callTool("ro", { text: "$8" }, { timeoutMs: 5_000 });
    expect(res).toEqual({ content: "$8", isError: false });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("idempotent-only tool (readOnlyHint false): retried once (2 calls)", async () => {
    const { src } = await readySource();
    const spy = dropNextCall();
    const res = await src.callTool("idem", { text: "x" }, { timeoutMs: 5_000 });
    expect(res).toEqual({ content: "x", isError: false });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("unannotated tool: unavailable, called exactly once", async () => {
    const { src } = await readySource();
    const spy = dropNextCall();
    const res = await src.callTool("echo", { text: "x" }, { timeoutMs: 5_000 });
    expect(res).toEqual({
      isError: true,
      content: "tool echo failed: unavailable",
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("read-only tool whose reconnect is not ready in time: unavailable within the call bound", async () => {
    const { src, srv } = await readySource(undefined, [10_000]);
    await srv.stop();
    servers.splice(servers.indexOf(srv), 1);
    const spy = vi.spyOn(Client.prototype, "callTool");
    const readySpy = vi.spyOn(src, "ready");
    const res = await src.callTool("ro", { text: "x" }, { timeoutMs: 300 });
    expect(res).toEqual({
      isError: true,
      content: "tool ro failed: unavailable",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    // The reconnect wait gets only what is left of the call's 300 ms bound.
    expect(readySpy).toHaveBeenCalledTimes(1);
    const waitMs = readySpy.mock.calls[0]![0];
    expect(waitMs).toBeGreaterThanOrEqual(0);
    expect(waitMs).toBeLessThanOrEqual(300);
    expect(src.status).toBe("connecting");
  });

  it("a tool-level isError result is never retried (1 call)", async () => {
    const { src } = await readySource();
    const spy = vi.spyOn(Client.prototype, "callTool");
    const res = await src.callTool(
      "ro_error",
      { text: "x" },
      { timeoutMs: 5_000 },
    );
    expect(res).toEqual({ content: "plan not found", isError: true });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("the connection-lost log line carries the cause class and code, not the arguments", async () => {
    const lines: Array<{ message: string; fields?: Record<string, unknown> }> =
      [];
    const { src } = await readySource((_level, message, fields) => {
      lines.push({ message, fields });
    });
    dropNextCall();
    await src.callTool("ro", { text: "private-arg" }, { timeoutMs: 5_000 });
    const lost = lines.find((l) => l.message === "mcp source connection lost");
    expect(lost?.fields).toMatchObject({
      source: "t",
      error: "TypeError",
      cause: "Error",
      causeCode: "ECONNRESET",
    });
    expect(JSON.stringify(lines)).not.toContain("private-arg");
  });
});
