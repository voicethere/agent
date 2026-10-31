import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { DocInput } from "./chunk.ts";

/** Corpus JSON: `{ documents: [{ id, title, url?, text }] }` (other keys ignored). */
export interface CorpusDoc extends DocInput {
  title: string;
  url?: string;
}

export function readCorpusFile(path: string): CorpusDoc[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as {
    documents?: unknown;
  };
  if (!Array.isArray(raw.documents)) {
    throw new Error(`${path}: "documents" must be an array`);
  }
  return raw.documents.map((d, i) => {
    const o = d as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.text !== "string") {
      throw new Error(`${path}: documents[${i}] needs string id and text`);
    }
    return {
      id: o.id,
      title: typeof o.title === "string" ? o.title : o.id,
      url: typeof o.url === "string" ? o.url : undefined,
      text: o.text,
    };
  });
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.toLowerCase().endsWith(".md")) out.push(p);
  }
}

/** Directory of `.md` files: id = relative path, title = first `#` heading or file name. */
export function readMarkdownDir(dir: string, baseUrl?: string): CorpusDoc[] {
  const files: string[] = [];
  walk(dir, files);
  return files.map((p) => {
    const id = relative(dir, p).split(sep).join("/");
    const text = readFileSync(p, "utf8");
    const m = /^# +(.+?) *#*\s*$/m.exec(text);
    const title = m?.[1]?.trim() || id.replace(/\.md$/i, "");
    const url = baseUrl
      ? `${baseUrl.replace(/\/+$/, "")}/${id.replace(/\.md$/i, "")}`
      : undefined;
    return { id, title, url, text };
  });
}

export function contentHash(docs: CorpusDoc[]): string {
  const h = createHash("sha256");
  for (const d of [...docs].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    h.update(JSON.stringify([d.id, d.title, d.url ?? "", d.text]));
  }
  return h.digest("hex");
}
