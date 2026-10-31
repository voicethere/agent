import { readFileSync } from "node:fs";
import type { Index } from "./search.ts";

export interface Question {
  q: string;
  docId: string;
  fact?: string;
}

export interface Metrics {
  recallAt4: number;
  mrr: number;
}

export interface EvalResult {
  vector: Metrics;
  text: Metrics;
  hybrid: Metrics;
  questions: number;
}

export function readQuestions(path: string): Question[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(raw)) throw new Error(`${path}: expected an array`);
  return raw.map((x, i) => {
    const o = x as Record<string, unknown>;
    if (typeof o.q !== "string" || typeof o.docId !== "string") {
      throw new Error(`${path}: [${i}] needs string q and docId`);
    }
    return {
      q: o.q,
      docId: o.docId,
      fact: typeof o.fact === "string" ? o.fact : undefined,
    };
  });
}

/** Rank of the first chunk of `docId` among the chunk ids (1-based), or 0. */
function docRank(index: Index, ids: number[], docId: string): number {
  for (let i = 0; i < ids.length; i++) {
    if (index.chunk(ids[i]!)?.docId === docId) return i + 1;
  }
  return 0;
}

export async function evaluate(
  index: Index,
  questions: Question[],
): Promise<EvalResult> {
  const ranks = {
    vector: [] as number[],
    text: [] as number[],
    hybrid: [] as number[],
  };
  for (const q of questions) {
    ranks.vector.push(docRank(index, await index.vectorIds(q.q), q.docId));
    ranks.text.push(docRank(index, index.textIds(q.q), q.docId));
    const hy = (await index.hybridIds(q.q)).map(([id]) => id);
    ranks.hybrid.push(docRank(index, hy, q.docId));
  }
  const m = (r: number[]): Metrics => ({
    recallAt4: r.filter((x) => x >= 1 && x <= 4).length / Math.max(1, r.length),
    mrr: r.reduce((s, x) => s + (x > 0 ? 1 / x : 0), 0) / Math.max(1, r.length),
  });
  return {
    vector: m(ranks.vector),
    text: m(ranks.text),
    hybrid: m(ranks.hybrid),
    questions: questions.length,
  };
}
