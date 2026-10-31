import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { MANIFEST, type Manifest, TEXT_DB, VECTORS_DB } from "./build-index.ts";
import type { Embedder } from "./embed.ts";

export const CANDIDATES = 20;
export const RRF_K0 = 60;

export interface Hit {
  chunkId: number;
  docId: string;
  title: string;
  url: string;
  text: string;
  score: number;
}

/** Every whitespace-separated token is double-quoted, so input is never FTS5 syntax. */
export function ftsQuery(input: string): string {
  const tokens = input
    .split(/\s+/)
    .map((t) => t.replaceAll('"', '""'))
    .filter((t) => t.replaceAll('"', "") !== "");
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

/** Reciprocal rank fusion over ranked id lists (best first); ids are deduped. */
export function rrf(lists: number[][], k0 = RRF_K0): Array<[number, number]> {
  const scores = new Map<number, number>();
  for (const list of lists) {
    const seen = new Set<number>();
    let rank = 0;
    for (const id of list) {
      if (seen.has(id)) continue;
      seen.add(id);
      rank++;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k0 + rank));
    }
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
}

export interface Index {
  manifest: Manifest;
  vectorIds(query: string): Promise<number[]>;
  textIds(query: string): number[];
  hybridIds(query: string): Promise<Array<[number, number]>>;
  chunk(id: number): Omit<Hit, "score"> | undefined;
  /** Whole page text, chunks in order. */
  doc(docId: string): { title: string; url: string; text: string } | undefined;
  close(): void;
}

export function openIndex(dir: string, embedder: Embedder): Index {
  const manifest = JSON.parse(
    readFileSync(join(dir, MANIFEST), "utf8"),
  ) as Manifest;
  if (manifest.model !== embedder.model || manifest.dims !== embedder.dims) {
    throw new Error(
      `index was built with ${manifest.model}/${manifest.dims}, embedder is ${embedder.model}/${embedder.dims}`,
    );
  }
  const text = new Database(join(dir, TEXT_DB), {
    readonly: true,
    fileMustExist: true,
  });
  const vec = new Database(join(dir, VECTORS_DB), {
    readonly: true,
    fileMustExist: true,
  });
  sqliteVec.load(vec);

  const vecStmt = vec.prepare(
    "select rowid from vec_chunks where embedding match ? and k = ? order by distance",
  );
  const ftsStmt = text.prepare(
    "select rowid from chunks_fts where chunks_fts match ? order by bm25(chunks_fts) limit ?",
  );
  const chunkStmt = text.prepare(
    "select id, doc_id, title, url, text from chunks where id = ?",
  );
  const docStmt = text.prepare(
    "select title, url, text from chunks where doc_id = ? order by id",
  );

  const index: Index = {
    manifest,
    async vectorIds(query) {
      const q = await embedder.embedQuery(query);
      const rows = vecStmt.all(
        Buffer.from(q.buffer, q.byteOffset, q.byteLength),
        BigInt(CANDIDATES),
      ) as Array<{ rowid: number | bigint }>;
      return rows.map((r) => Number(r.rowid));
    },
    textIds(query) {
      const q = ftsQuery(query);
      if (q === "") return [];
      const rows = ftsStmt.all(q, CANDIDATES) as Array<{ rowid: number }>;
      return rows.map((r) => Number(r.rowid));
    },
    async hybridIds(query) {
      return rrf([await index.vectorIds(query), index.textIds(query)]);
    },
    chunk(id) {
      const r = chunkStmt.get(id) as
        | {
            id: number;
            doc_id: string;
            title: string;
            url: string;
            text: string;
          }
        | undefined;
      return r
        ? {
            chunkId: r.id,
            docId: r.doc_id,
            title: r.title,
            url: r.url,
            text: r.text,
          }
        : undefined;
    },
    doc(docId) {
      const rows = docStmt.all(docId) as Array<{
        title: string;
        url: string;
        text: string;
      }>;
      if (rows.length === 0) return undefined;
      return {
        title: rows[0]!.title.split(" › ")[0]!,
        url: rows[0]!.url,
        text: rows.map((r) => r.text).join("\n\n"),
      };
    },
    close() {
      text.close();
      vec.close();
    },
  };
  return index;
}

/** Hybrid search: up to `k` hits, best first, `score` = RRF score. */
export async function searchHybrid(
  index: Index,
  query: string,
  k = 5,
): Promise<Hit[]> {
  const fused = await index.hybridIds(query);
  const hits: Hit[] = [];
  for (const [id, score] of fused.slice(0, k)) {
    const c = index.chunk(id);
    if (c) hits.push({ ...c, score });
  }
  return hits;
}
