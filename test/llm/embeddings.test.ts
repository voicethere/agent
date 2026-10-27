import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createLlmEmbedder } from "../../src/llm/providers.js";
import { withEmbedBounds } from "../../src/llm/bounded-embedder.js";
import { openai } from "../../src/llm/openai.js";
import { gemini } from "../../src/llm/gemini.js";
import { anthropic } from "../../src/llm/anthropic.js";
import { LlmProviderError } from "../../src/llm/types.js";
import type { LlmEmbedder } from "../../src/llm/types.js";

interface Reply {
  status?: number;
  json?: unknown;
  hang?: boolean;
}
interface Mock {
  baseUrl: string;
  requests: { url: string; body: any; auth?: string }[];
  close(): Promise<void>;
}

/** Local server that answers with the documented response shapes. */
async function startServer(
  respond: (n: number, body: any, url: string) => Reply,
): Promise<Mock> {
  const requests: Mock["requests"] = [];
  const open = new Set<import("node:net").Socket>();
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body: any;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        /* none */
      }
      const n = requests.length;
      requests.push({
        url: req.url ?? "",
        body,
        auth: req.headers.authorization,
      });
      const r = respond(n, body, req.url ?? "");
      if (r.hang) return;
      res.writeHead(r.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(r.json ?? {}));
    });
  });
  server.on("connection", (s) => {
    open.add(s);
    s.on("close", () => open.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      for (const s of open) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

const vec = (seed: number, dims = 4) =>
  Array.from({ length: dims }, (_, i) => seed + i / 10);

/** OpenAI-shaped response for `inputs`, in reverse order to test `index`. */
const openaiReply = (inputs: string[], dims = 4) => ({
  object: "list",
  model: "text-embedding-3-small",
  data: inputs
    .map((_, index) => ({
      object: "embedding",
      index,
      embedding: Array.from({ length: dims }, (_, i) =>
        i === index % dims ? 1 : 0.5,
      ),
    }))
    .reverse(),
  usage: { prompt_tokens: inputs.length * 2, total_tokens: inputs.length * 2 },
});

describe("embeddings", () => {
  let mock: Mock | undefined;
  afterEach(async () => {
    await mock?.close();
    mock = undefined;
  });

  const make = (
    baseUrl: string,
    provider: "openai" | "openrouter" = "openai",
  ) =>
    createLlmEmbedder(
      {
        provider,
        apiKey: "k",
        baseUrl,
        embedBounds: { retryDelayMs: 1, timeoutMs: 2000 },
      },
      [openai, gemini, anthropic],
    );

  it("openai: sends model/input/dimensions/encoding_format, orders by index, reports tokens", async () => {
    mock = await startServer((_, body) => ({
      json: openaiReply(body.input),
    }));
    const e = make(mock.baseUrl);
    const res = await e.embed({
      model: "text-embedding-3-small",
      inputs: ["a", "b", "c"],
      dimensions: 4,
    });
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0].url).toBe("/embeddings");
    expect(mock.requests[0].body).toMatchObject({
      model: "text-embedding-3-small",
      input: ["a", "b", "c"],
      dimensions: 4,
      encoding_format: "float",
    });
    expect(res.vectors.map((v) => v.indexOf(Math.max(...v)))).toEqual([
      0, 1, 2,
    ]);
    expect(res.dims).toBe(4);
    expect(res.inputTokens).toBe(6);
  });

  it("openrouter: same documented /embeddings call on its base URL", async () => {
    mock = await startServer((_, body) => ({ json: openaiReply(body.input) }));
    const e = make(mock.baseUrl, "openrouter");
    const res = await e.embed({
      model: "openai/text-embedding-3-small",
      inputs: ["a"],
      dimensions: 4,
    });
    expect(mock.requests[0].url).toBe("/embeddings");
    expect(mock.requests[0].body.model).toBe("openai/text-embedding-3-small");
    expect(res.vectors).toHaveLength(1);
  });

  it("gemini: embedContent with outputDimensionality, ordered values", async () => {
    mock = await startServer((_, body) => {
      const reqs: any[] = body.requests ?? [];
      return {
        json: {
          embeddings: reqs.map((_, i) => ({ values: vec(i) })),
        },
      };
    });
    const e = createLlmEmbedder(
      {
        provider: "gemini",
        apiKey: "k",
        baseUrl: mock.baseUrl,
        embedBounds: { retryDelayMs: 1, timeoutMs: 2000 },
      },
      [gemini],
    );
    const res = await e.embed({
      model: "gemini-embedding-001",
      inputs: ["a", "b"],
      dimensions: 4,
    });
    expect(mock.requests[0].url).toContain("gemini-embedding-001");
    expect(JSON.stringify(mock.requests[0].body)).toContain(
      '"outputDimensionality":4',
    );
    expect(res.vectors).toHaveLength(2);
    expect(res.dims).toBe(4);
    expect(res.inputTokens).toBeUndefined();
  });

  it("batches 200 inputs at maxBatch 96 into 3 requests, order kept", async () => {
    mock = await startServer((_, body) => ({
      json: {
        object: "list",
        model: "m",
        data: (body.input as string[]).map((s, index) => ({
          object: "embedding",
          index,
          embedding: [1, Number(s)],
        })),
        usage: { prompt_tokens: 1, total_tokens: 1 },
      },
    }));
    const e = createLlmEmbedder(
      { provider: "openai", apiKey: "k", baseUrl: mock.baseUrl },
      [openai],
    );
    const inputs = Array.from({ length: 200 }, (_, i) => String(i));
    const res = await e.embed({ model: "m", inputs });
    expect(mock.requests.map((r) => r.body.input.length)).toEqual([96, 96, 8]);
    expect(res.vectors.map((v) => Math.round(v[1] / v[0]))).toEqual(
      inputs.map(Number),
    );
    expect(res.inputTokens).toBe(3);
  });

  it("timeout: 3 attempts then LLM_TIMEOUT", async () => {
    mock = await startServer(() => ({ hang: true }));
    const e = createLlmEmbedder(
      {
        provider: "openai",
        apiKey: "k",
        baseUrl: mock.baseUrl,
        embedBounds: { timeoutMs: 50, retries: 2, retryDelayMs: 1 },
      },
      [openai],
    );
    await expect(e.embed({ model: "m", inputs: ["x"] })).rejects.toMatchObject({
      code: "LLM_TIMEOUT",
    });
    expect(mock.requests).toHaveLength(3);
  });

  it("caller abort: LLM_ABORTED after 1 attempt, no retry", async () => {
    mock = await startServer(() => ({ hang: true }));
    const e = createLlmEmbedder(
      {
        provider: "openai",
        apiKey: "k",
        baseUrl: mock.baseUrl,
        embedBounds: { timeoutMs: 5000, retries: 2, retryDelayMs: 1 },
      },
      [openai],
    );
    const ctl = new AbortController();
    const p = e.embed({ model: "m", inputs: ["x"], signal: ctl.signal });
    const settled = p.catch((err) => err);
    while (mock.requests.length === 0)
      await new Promise((r) => setTimeout(r, 5));
    ctl.abort();
    const err = await settled;
    expect(err).toBeInstanceOf(LlmProviderError);
    expect(err.code).toBe("LLM_ABORTED");
    expect(mock.requests).toHaveLength(1);
  });

  it("429 then 200 succeeds with 2 requests", async () => {
    mock = await startServer((n, body) =>
      n === 0
        ? { status: 429, json: { error: { message: "SECRET-BODY" } } }
        : { json: openaiReply(body.input) },
    );
    const res = await make(mock.baseUrl).embed({ model: "m", inputs: ["a"] });
    expect(mock.requests).toHaveLength(2);
    expect(res.vectors).toHaveLength(1);
  });

  it("401 is LLM_AUTH_FAILED after 1 request", async () => {
    mock = await startServer(() => ({
      status: 401,
      json: { error: { message: "SECRET-BODY" } },
    }));
    const err = await make(mock.baseUrl)
      .embed({ model: "m", inputs: ["a"] })
      .catch((e) => e);
    expect(err.code).toBe("LLM_AUTH_FAILED");
    expect(err.message).not.toContain("SECRET-BODY");
    expect(mock.requests).toHaveLength(1);
  });

  it("dims mismatch is LLM_PROVIDER_ERROR", async () => {
    mock = await startServer((_, body) => ({
      json: openaiReply(body.input, 8),
    }));
    await expect(
      make(mock.baseUrl).embed({ model: "m", inputs: ["a"], dimensions: 4 }),
    ).rejects.toMatchObject({
      code: "LLM_PROVIDER_ERROR",
      message: expect.stringContaining("dims mismatch"),
    });
  });

  it("anthropic: LLM_EMBEDDINGS_UNSUPPORTED", () => {
    expect(() =>
      createLlmEmbedder({ provider: "anthropic", apiKey: "k" }, [anthropic]),
    ).toThrowError(
      expect.objectContaining({ code: "LLM_EMBEDDINGS_UNSUPPORTED" }),
    );
  });

  it("error messages never contain the input text", async () => {
    const SENTINEL = "SENTINEL-INPUT-TEXT-123";
    mock = await startServer(() => ({
      status: 500,
      json: { error: { message: SENTINEL } },
    }));
    const err = await createLlmEmbedder(
      {
        provider: "openai",
        apiKey: "k",
        baseUrl: mock.baseUrl,
        embedBounds: { retries: 0 },
      },
      [openai],
    )
      .embed({ model: "m", inputs: [SENTINEL] })
      .catch((e) => e);
    expect(err.code).toBe("LLM_PROVIDER_ERROR");
    expect(err.message).not.toContain(SENTINEL);
  });

  const one = (embedding: number[]) => ({
    json: {
      object: "list",
      model: "m",
      data: [{ object: "embedding", index: 0, embedding }],
      usage: { prompt_tokens: 1, total_tokens: 1 },
    },
  });

  it("count mismatch fails fast without retry", async () => {
    mock = await startServer(() => ({ json: openaiReply(["only-one"]) }));
    const err = await make(mock.baseUrl)
      .embed({ model: "m", inputs: ["a", "b"] })
      .catch((e) => e);
    expect(err.code).toBe("LLM_PROVIDER_ERROR");
    expect(err.message).toContain("count mismatch");
    expect(mock.requests).toHaveLength(1);
  });

  it("normalizes vectors to unit length", async () => {
    mock = await startServer(() => one([3, 4]));
    const res = await make(mock.baseUrl).embed({ model: "m", inputs: ["a"] });
    expect(res.vectors[0][0]).toBeCloseTo(0.6, 10);
    expect(res.vectors[0][1]).toBeCloseTo(0.8, 10);
  });

  it("zero vector fails fast", async () => {
    mock = await startServer(() => one([0, 0]));
    const err = await make(mock.baseUrl)
      .embed({ model: "m", inputs: ["a"] })
      .catch((e) => e);
    expect(err.code).toBe("LLM_PROVIDER_ERROR");
    expect(err.message).toContain("all zeros");
    expect(mock.requests).toHaveLength(1);
  });

  it("gemini: embedding without values fails fast as empty", async () => {
    mock = await startServer(() => ({ json: { embeddings: [{}] } }));
    const e = createLlmEmbedder(
      {
        provider: "gemini",
        apiKey: "k",
        baseUrl: mock.baseUrl,
        embedBounds: { retryDelayMs: 1, timeoutMs: 2000 },
      },
      [gemini],
    );
    const err = await e
      .embed({ model: "gemini-embedding-001", inputs: ["a"] })
      .catch((x) => x);
    expect(err.code).toBe("LLM_PROVIDER_ERROR");
    expect(err.message).toContain("empty");
    expect(mock.requests).toHaveLength(1);
  });

  it("withEmbedBounds: a 4xx other than the mapped ones is not retried", async () => {
    let calls = 0;
    const inner: LlmEmbedder = {
      id: "openai",
      async embed() {
        calls++;
        throw new LlmProviderError("LLM_PROVIDER_ERROR", "teapot", 418);
      },
    };
    await expect(
      withEmbedBounds(inner, { retryDelayMs: 1 }).embed({
        model: "m",
        inputs: ["a"],
      }),
    ).rejects.toMatchObject({ status: 418 });
    expect(calls).toBe(1);
  });
});
