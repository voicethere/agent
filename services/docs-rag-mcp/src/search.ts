import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { MANIFEST, type Manifest, TEXT_DB, VECTORS_DB } from "./build-index.ts";
import { type SearchConfig, searchConfig } from "./config.ts";
import type { Embedder } from "./embed.ts";
import { isStopWord } from "./stopwords.ts";

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

/**
 * Stop words are dropped, then every remaining whitespace-separated token is
 * double-quoted, so input is never FTS5 syntax. All stop words → "".
 */
export function ftsQuery(input: string): string {
  const tokens = input
    .split(/\s+/)
    .filter((t) => !isStopWord(t))
    .map((t) => t.replaceAll('"', '""'))
    .filter((t) => t.replaceAll('"', "") !== "");
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

export interface RankedList {
  ids: number[];
  weight: number;
}

/**
 * Weighted reciprocal rank fusion: score = sum of weight / (k0 + rank) over
 * the lists. Ids are deduped within a list; ties break by id.
 */
export function rrf(lists: RankedList[], k0 = RRF_K0): Array<[number, number]> {
  const scores = new Map<number, number>();
  for (const { ids, weight } of lists) {
    const seen = new Set<number>();
    let rank = 0;
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      rank++;
      scores.set(id, (scores.get(id) ?? 0) + weight / (k0 + rank));
    }
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
}

/**
 * At most `maxPerDoc` chunks per document in the first `k` results, taken in
 * fused order; if that leaves fewer than `k`, the skipped chunks fill the rest.
 */
export function diversify(
  ids: number[],
  docOf: (id: number) => string | undefined,
  k: number,
  maxPerDoc: number,
): number[] {
  const out: number[] = [];
  const skipped: number[] = [];
  const perDoc = new Map<string, number>();
  for (const id of ids) {
    if (out.length >= k) break;
    const doc = docOf(id) ?? `#${id}`;
    const n = perDoc.get(doc) ?? 0;
    if (n >= maxPerDoc) {
      skipped.push(id);
      continue;
    }
    perDoc.set(doc, n + 1);
    out.push(id);
  }
  for (const id of skipped) {
    if (out.length >= k) break;
    out.push(id);
  }
  return out;
}

export interface Index {
  manifest: Manifest;
  vectorIds(query: string): Promise<number[]>;
  textIds(query: string): number[];
  hybridIds(
    query: string,
    cfg?: SearchConfig,
  ): Promise<Array<[number, number]>>;
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
    async hybridIds(query, cfg = searchConfig()) {
      return rrf([
        { ids: await index.vectorIds(query), weight: cfg.vectorWeight },
        { ids: index.textIds(query), weight: cfg.textWeight },
      ]);
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

/** Hybrid search: up to `k` hits, best first, `score` = weighted RRF score. */
export async function searchHybrid(
  index: Index,
  query: string,
  k = 5,
  cfg: SearchConfig = searchConfig(),
): Promise<Hit[]> {
  const fused = await index.hybridIds(query, cfg);
  const score = new Map(fused);
  const ids = diversify(
    fused.map(([id]) => id),
    (id) => index.chunk(id)?.docId,
    k,
    cfg.maxPerDoc,
  );
  const hits: Hit[] = [];
  for (const id of ids) {
    const c = index.chunk(id);
    if (c) hits.push({ ...c, score: score.get(id) ?? 0 });
  }
  return hits;
}
