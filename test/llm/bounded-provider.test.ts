import { afterEach, describe, expect, it } from "vitest";
import { createLlmProvider } from "../../src/llm/index.js";
import { openai } from "../../src/llm/openai.js";
import type { LlmRequest } from "../../src/llm/types.js";
import { collect, sseData, startMock, type MockServer } from "./mock-server.js";

const chunk = (content: string, finish: string | null = null) =>
  sseData({
    id: "c",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: [{ index: 0, delta: { content }, finish_reason: finish }],
  });
const OK_SSE = chunk("Hi") + chunk("", "stop") + "data: [DONE]\n\n";

const req: LlmRequest = {
  model: "m",
  system: "s",
  messages: [{ role: "user", text: "x" }],
  tools: [],
};

describe("withStreamBounds", () => {
  let mock: MockServer | undefined;
  afterEach(async () => {
    await mock?.close();
    mock = undefined;
  });
  const make = (bounds = {}) =>
    createLlmProvider(
      {
        provider: "openai",
        apiKey: "k",
        baseUrl: mock!.baseUrl,
        bounds: { retryDelayMs: 5, ...bounds },
      },
      [openai],
    );

  it("retries once on 429 before any text", async () => {
    mock = await startMock([{ status: 429 }, { sse: OK_SSE }]);
    const events = await collect(make().stream(req));
    expect(events.at(-1)).toMatchObject({ type: "done", text: "Hi" });
    expect(mock.requests).toHaveLength(2);
  });

  it("does not retry after text was yielded", async () => {
    // Text arrives, then the stream stalls past the total bound.
    mock = await startMock([
      { sse: chunk("Hi"), stallAfter: true },
      { sse: OK_SSE },
    ]);
    const got: unknown[] = [];
    let err: any;
    try {
      for await (const e of make({ totalTimeoutMs: 200 }).stream(req))
        got.push(e);
    } catch (e) {
      err = e;
    }
    expect(got).toEqual([{ type: "text_delta", text: "Hi" }]);
    expect(err?.code).toBe("LLM_TIMEOUT");
    expect(mock.requests).toHaveLength(1);
  });

  it("first-token timeout throws LLM_TIMEOUT", async () => {
    mock = await startMock([{ hang: true }]);
    await expect(
      collect(make({ firstTokenTimeoutMs: 50, retries: 0 }).stream(req)),
    ).rejects.toMatchObject({ code: "LLM_TIMEOUT" });
  });

  it("caller abort throws LLM_ABORTED without retry", async () => {
    mock = await startMock([{ hang: true }, { sse: OK_SSE }]);
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 50);
    await expect(
      collect(make().stream({ ...req, signal: ctl.signal })),
    ).rejects.toMatchObject({ code: "LLM_ABORTED" });
    expect(mock.requests).toHaveLength(1);
  });

  it("401 maps to LLM_AUTH_FAILED and the message has no response body", async () => {
    mock = await startMock([{ status: 401 }]);
    let err: any;
    try {
      await collect(make().stream(req));
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe("LLM_AUTH_FAILED");
    expect(err.status).toBe(401);
    expect(err.message).toBe("openai 401");
    expect(err.message).not.toContain("SECRET-BODY");
    expect(mock.requests).toHaveLength(1);
  });

  it("an in-stream error chunk keeps only its code: vendorCode, stream, no message", async () => {
    // OpenRouter Streaming > Handling errors during streaming > Errors after
    // the response is committed: top-level `error` plus finish_reason "error".
    mock = await startMock([
      {
        sse:
          sseData({
            id: "x",
            object: "chat.completion.chunk",
            error: { code: 424, message: "SECRET-BODY" },
            choices: [
              { index: 0, delta: { content: "" }, finish_reason: "error" },
            ],
          }) + "data: [DONE]\n\n",
      },
    ]);
    let err: any;
    try {
      await collect(make({ retries: 0 }).stream(req));
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe("LLM_PROVIDER_ERROR");
    expect(err.status).toBeUndefined();
    expect(err.vendorCode).toBe(424);
    expect(err.stream).toBe(true);
    expect(err.message).toBe("openai stream error");
    expect(err.message).not.toContain("SECRET-BODY");
  });

  it("an HTTP 503 keeps its status and the body code, not the message", async () => {
    mock = await startMock([
      {
        status: 503,
        json: { error: { code: "server_error", message: "SECRET-BODY" } },
      },
    ]);
    let err: any;
    try {
      await collect(make({ retries: 0 }).stream(req));
    } catch (e) {
      err = e;
    }
    expect(err.code).toBe("LLM_PROVIDER_ERROR");
    expect(err.status).toBe(503);
    expect(err.vendorCode).toBe("server_error");
    expect(err.stream).toBeUndefined();
    expect(err.message).toBe("openai 503");
    expect(err.message).not.toContain("SECRET-BODY");
  });
});
