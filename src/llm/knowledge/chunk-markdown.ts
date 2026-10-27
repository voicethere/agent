import type { KnowledgeDocument } from "./types.js";

export interface MarkdownChunk {
  /** `${doc.id}#${n}` */
  id: string;
  source: string;
  title: string;
  text: string;
}

export interface ChunkOptions {
  maxWords?: number;
  overlapWords?: number;
}

export const DEFAULT_CHUNK_WORDS = 300;
export const DEFAULT_CHUNK_OVERLAP_WORDS = 50;

const HEADING = /^(#{1,3})\s+(.+?)\s*#*\s*$/;

/**
 * Splits Markdown on `#`..`###` headings, then into windows of `maxWords`
 * words that overlap by `overlapWords`. Headings inside code fences are text.
 */
export function chunkMarkdown(
  doc: KnowledgeDocument,
  opts: ChunkOptions = {},
): MarkdownChunk[] {
  const maxWords = opts.maxWords ?? DEFAULT_CHUNK_WORDS;
  const overlap = opts.overlapWords ?? DEFAULT_CHUNK_OVERLAP_WORDS;
  if (!Number.isInteger(maxWords) || maxWords < 1) {
    throw new RangeError("maxWords must be a positive integer");
  }
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= maxWords) {
    throw new RangeError("overlapWords must be >= 0 and < maxWords");
  }

  const stack: string[] = ["", "", ""];
  const titleOf = (): string => {
    const parts = [doc.title ?? "", ...stack].filter((p) => p !== "");
    return parts.length > 0 ? parts.join(" › ") : doc.id;
  };

  const sections: Array<{ title: string; lines: string[] }> = [];
  let current = { title: titleOf(), lines: [] as string[] };
  let fenced = false;
  for (const line of doc.text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const m = fenced ? null : HEADING.exec(line);
    if (m) {
      sections.push(current);
      const level = m[1]!.length;
      stack[level - 1] = m[2]!;
      for (let i = level; i < stack.length; i++) stack[i] = "";
      current = { title: titleOf(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);

  const chunks: MarkdownChunk[] = [];
  const push = (title: string, text: string) => {
    chunks.push({
      id: `${doc.id}#${chunks.length}`,
      source: doc.id,
      title,
      text,
    });
  };
  for (const section of sections) {
    const body = section.lines.join("\n").trim();
    if (body === "") continue;
    const words = body.split(/\s+/);
    if (words.length <= maxWords) {
      push(section.title, body);
      continue;
    }
    const step = maxWords - overlap;
    for (let start = 0; ; start += step) {
      push(section.title, words.slice(start, start + maxWords).join(" "));
      if (start + maxWords >= words.length) break;
    }
  }
  return chunks;
}
