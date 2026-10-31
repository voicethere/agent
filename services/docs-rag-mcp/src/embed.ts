import { env, pipeline } from "@huggingface/transformers";

export const MODEL_ID = "Xenova/bge-small-en-v1.5";
export const DIMS = 384;
/** bge-small-en-v1.5 model card: prefix for short queries, none for passages. */
export const QUERY_PREFIX =
  "Represent this sentence for searching relevant passages: ";

export interface Embedder {
  readonly model: string;
  readonly dims: number;
  embedPassages(texts: string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
}

type Extractor = (
  input: string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array | number[]; dims: number[] }>;

/**
 * Local embedder: quantized ONNX model read from `modelDir` (layout
 * `<modelDir>/Xenova/bge-small-en-v1.5/...`). Remote downloads are disabled.
 */
export async function createEmbedder(
  modelDir = process.env.DOCS_RAG_MODEL_DIR,
): Promise<Embedder> {
  if (!modelDir) throw new Error("DOCS_RAG_MODEL_DIR is not set");
  env.localModelPath = modelDir;
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  const extractor = (await pipeline("feature-extraction", MODEL_ID, {
    dtype: "q8",
  })) as unknown as Extractor;

  const run = async (texts: string[]): Promise<Float32Array[]> => {
    const out: Float32Array[] = [];
    const batch = 16;
    for (let i = 0; i < texts.length; i += batch) {
      const part = texts.slice(i, i + batch);
      const t = await extractor(part, { pooling: "mean", normalize: true });
      const flat = Float32Array.from(t.data as ArrayLike<number>);
      for (let j = 0; j < part.length; j++) {
        out.push(flat.slice(j * DIMS, (j + 1) * DIMS));
      }
    }
    return out;
  };
  return {
    model: MODEL_ID,
    dims: DIMS,
    embedPassages: run,
    embedQuery: async (text) => (await run([QUERY_PREFIX + text]))[0]!,
  };
}
