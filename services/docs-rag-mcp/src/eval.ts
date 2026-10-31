import { readFileSync } from "node:fs";
import { type SearchConfig, searchConfig } from "./config.ts";
import { type Index, diversify } from "./search.ts";

export interface Question {
  q: string;
  docId: string;
  fact?: string;
}

export interface Metrics {
  /** Over the returned chunk list (hybrid: after per-doc diversity). */
  recallAt4: number;
  /** Same, but the list is cut to the first 4 distinct documents. */
  docRecallAt4: number;
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

/** Ranks (1-based, 0 = absent) of the first chunk of `docId`, by chunk and by distinct document. */
function ranks(index: Index, ids: number[], docId: string): [number, number] {
  const seen = new Set<string>();
  for (let i = 0; i < ids.length; i++) {
    const d = index.chunk(ids[i]!)?.docId;
    if (d === undefined) continue;
    if (d === docId) return [i + 1, seen.size + 1];
    seen.add(d);
  }
  return [0, 0];
}

export async function evaluate(
  index: Index,
  questions: Question[],
  cfg: SearchConfig = searchConfig(),
): Promise<EvalResult> {
  const acc = {
    vector: [] as Array<[number, number]>,
    text: [] as Array<[number, number]>,
    hybrid: [] as Array<[number, number]>,
  };
  for (const q of questions) {
    acc.vector.push(ranks(index, await index.vectorIds(q.q), q.docId));
    acc.text.push(ranks(index, index.textIds(q.q), q.docId));
    const fused = (await index.hybridIds(q.q, cfg)).map(([id]) => id);
    const shown = diversify(
      fused,
      (id) => index.chunk(id)?.docId,
      fused.length,
      cfg.maxPerDoc,
    );
    acc.hybrid.push(ranks(index, shown, q.docId));
  }
  const m = (r: Array<[number, number]>): Metrics => {
    const n = Math.max(1, r.length);
    return {
      recallAt4: r.filter(([c]) => c >= 1 && c <= 4).length / n,
      docRecallAt4: r.filter(([, d]) => d >= 1 && d <= 4).length / n,
      mrr: r.reduce((s, [c]) => s + (c > 0 ? 1 / c : 0), 0) / n,
    };
  };
  return {
    vector: m(acc.vector),
    text: m(acc.text),
    hybrid: m(acc.hybrid),
    questions: questions.length,
  };
}
