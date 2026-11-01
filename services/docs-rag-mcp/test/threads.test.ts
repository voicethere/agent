import { beforeEach, describe, expect, it, vi } from "vitest";

const pipeline = vi.fn();
vi.mock("@huggingface/transformers", () => ({
  env: {},
  pipeline: (...args: unknown[]) => pipeline(...args),
}));

const { embedThreads, DEFAULT_THREADS } = await import("../src/config.ts");
const { createEmbedder, MODEL_ID } = await import("../src/embed.ts");

describe("embedThreads (DOCS_RAG_THREADS)", () => {
  it("defaults to 1 when unset or empty", () => {
    expect(DEFAULT_THREADS).toBe(1);
    expect(embedThreads({})).toBe(1);
    expect(embedThreads({ DOCS_RAG_THREADS: "" })).toBe(1);
  });
  it("accepts a positive integer", () => {
    expect(embedThreads({ DOCS_RAG_THREADS: "4" })).toBe(4);
  });
  it.each(["0", "-1", "abc", "1.5"])("rejects %j", (raw) => {
    expect(() => embedThreads({ DOCS_RAG_THREADS: raw })).toThrow(
      "DOCS_RAG_THREADS must be a positive integer",
    );
  });
});

describe("createEmbedder session options", () => {
  beforeEach(() => {
    pipeline.mockReset();
    pipeline.mockResolvedValue(async () => ({ data: [], dims: [0, 384] }));
  });
  it("passes intraOpNumThreads N and interOpNumThreads 1 to pipeline", async () => {
    await createEmbedder("/model", { threads: 3 });
    expect(pipeline).toHaveBeenCalledWith("feature-extraction", MODEL_ID, {
      dtype: "q8",
      session_options: { intraOpNumThreads: 3, interOpNumThreads: 1 },
    });
  });
  it("omits session_options when threads is unset", async () => {
    await createEmbedder("/model");
    expect(pipeline).toHaveBeenCalledWith("feature-extraction", MODEL_ID, {
      dtype: "q8",
    });
  });
});
