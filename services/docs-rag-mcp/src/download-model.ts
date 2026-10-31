// Fetches the model into DOCS_RAG_MODEL_DIR (image build / CI step only).
import { env, pipeline } from "@huggingface/transformers";
import { MODEL_ID } from "./embed.ts";

const dir = process.env.DOCS_RAG_MODEL_DIR;
if (!dir) {
  console.error("DOCS_RAG_MODEL_DIR is not set");
  process.exit(2);
}
env.cacheDir = dir;
await pipeline("feature-extraction", MODEL_ID, { dtype: "q8" });
console.log(`model ${MODEL_ID} stored in ${dir}`);
