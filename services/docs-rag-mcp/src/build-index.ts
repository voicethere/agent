import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { chunkMarkdown } from "./chunk.ts";
import { type CorpusDoc, contentHash } from "./corpus.ts";
import type { Embedder } from "./embed.ts";

export interface Manifest {
  contentHash: string;
  model: string;
  dims: number;
  chunks: number;
  builtAt: string;
}

export const VECTORS_DB = "vectors.db";
export const TEXT_DB = "text.db";
export const MANIFEST = "manifest.json";

export async function buildIndex(opts: {
  docs: CorpusDoc[];
  embedder: Embedder;
  outDir: string;
}): Promise<Manifest> {
  const { docs, embedder, outDir } = opts;
  mkdirSync(outDir, { recursive: true });
  for (const f of [VECTORS_DB, TEXT_DB, MANIFEST]) {
    rmSync(join(outDir, f), { force: true });
  }

  const chunks = docs.flatMap((d) =>
    chunkMarkdown({ id: d.id, title: d.title, text: d.text }).map((c) => ({
      ...c,
      url: d.url ?? "",
    })),
  );
  // Passages are embedded as "title\ntext" so the heading path counts.
  const vectors = await embedder.embedPassages(
    chunks.map((c) => `${c.title}\n${c.text}`),
  );

  const text = new Database(join(outDir, TEXT_DB));
  text.exec(`
    create table chunks(id integer primary key, doc_id text not null, title text not null, url text not null, text text not null);
    create virtual table chunks_fts using fts5(title, text, tokenize='unicode61');
  `);
  const vec = new Database(join(outDir, VECTORS_DB));
  sqliteVec.load(vec);
  vec.exec(
    `create virtual table vec_chunks using vec0(embedding float[${embedder.dims}] distance_metric=cosine)`,
  );

  const insChunk = text.prepare(
    "insert into chunks(id, doc_id, title, url, text) values (?, ?, ?, ?, ?)",
  );
  const insFts = text.prepare(
    "insert into chunks_fts(rowid, title, text) values (?, ?, ?)",
  );
  const insVec = vec.prepare(
    "insert into vec_chunks(rowid, embedding) values (?, ?)",
  );
  text.transaction(() => {
    chunks.forEach((c, i) => {
      const rowid = i + 1;
      insChunk.run(rowid, c.source, c.title, c.url, c.text);
      insFts.run(rowid, c.title, c.text);
    });
  })();
  vec.transaction(() => {
    vectors.forEach((v, i) => {
      insVec.run(
        BigInt(i + 1),
        Buffer.from(v.buffer, v.byteOffset, v.byteLength),
      );
    });
  })();
  text.close();
  vec.close();

  const manifest: Manifest = {
    contentHash: contentHash(docs),
    model: embedder.model,
    dims: embedder.dims,
    chunks: chunks.length,
    builtAt: new Date().toISOString(),
  };
  writeFileSync(join(outDir, MANIFEST), JSON.stringify(manifest, null, 2));
  return manifest;
}
