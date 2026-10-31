#!/usr/bin/env node
import { parseArgs } from "node:util";
import { buildIndex } from "./build-index.ts";
import { readCorpusFile, readMarkdownDir } from "./corpus.ts";
import { createEmbedder } from "./embed.ts";
import { evaluate, readQuestions } from "./eval.ts";
import { openIndex } from "./search.ts";

const USAGE = `usage:
  docs-rag build (--corpus <file.json> | --docs <dir>) [--base-url <url>] --out <dir>
  docs-rag eval --index <dir> --questions <file.json> [--min-recall 0.9]
env: DOCS_RAG_MODEL_DIR (model directory, see "download-model")`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      corpus: { type: "string" },
      docs: { type: "string" },
      "base-url": { type: "string" },
      out: { type: "string" },
      index: { type: "string" },
      questions: { type: "string" },
      "min-recall": { type: "string" },
    },
  });
  if (cmd === "build") {
    if (!values.out || !!values.corpus === !!values.docs) {
      console.error(USAGE);
      return 2;
    }
    const docs = values.corpus
      ? readCorpusFile(values.corpus)
      : readMarkdownDir(values.docs!, values["base-url"]);
    const m = await buildIndex({
      docs,
      embedder: await createEmbedder(),
      outDir: values.out,
    });
    console.log(
      `built ${m.chunks} chunks from ${docs.length} documents (${m.model}, ${m.dims} dims, hash ${m.contentHash.slice(0, 12)})`,
    );
    return 0;
  }
  if (cmd === "eval") {
    if (!values.index || !values.questions) {
      console.error(USAGE);
      return 2;
    }
    const min = Number(values["min-recall"] ?? "0.9");
    const index = openIndex(values.index, await createEmbedder());
    const r = await evaluate(index, readQuestions(values.questions));
    index.close();
    console.log(`questions: ${r.questions}`);
    for (const name of ["vector", "text", "hybrid"] as const) {
      console.log(
        `${name.padEnd(7)} recall@4=${r[name].recallAt4.toFixed(3)} mrr=${r[name].mrr.toFixed(3)}`,
      );
    }
    if (r.hybrid.recallAt4 < min) {
      console.error(
        `hybrid recall@4 ${r.hybrid.recallAt4.toFixed(3)} < ${min}`,
      );
      return 1;
    }
    return 0;
  }
  console.error(USAGE);
  return 2;
}

process.exit(await main(process.argv.slice(2)));
