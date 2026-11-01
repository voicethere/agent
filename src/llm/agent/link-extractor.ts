/**
 * Takes links out of streamed reply text so speech never reads a URL aloud.
 *
 * Each URL is replaced by {@link LINK_MARK}, a private-use character the
 * sentence splitter does not cut on (a URL's own dots would otherwise split a
 * sentence). When a sentence is complete, {@link cleanLinkSentence} removes
 * the marks and tidies the words around them, and the caller takes one link
 * per mark with {@link LinkExtractor.takeLink}, in order.
 *
 * Matches markdown links `[label](https://…)` (the label stays in the text)
 * and bare `http(s)://…` up to the next whitespace, with trailing punctuation
 * given back to the text.
 */
export const LINK_MARK = "";

export interface ExtractedLink {
  url: string;
  label?: string;
  /** True for `https:`. Other links are removed from speech and never sent. */
  secure: boolean;
}

const SCHEMES = ["https://", "http://"];
const START_RE = /\[|https?:\/\//i;
const BARE_RE = /^https?:\/\/\S*/i;
const MARKDOWN_RE =
  /^\[([^[\]\n]{0,200})\]\((https?:\/\/[^\s()]+(?:\([^\s()]*\)[^\s()]*)*)\)/i;
/** A buffer that may still grow into a markdown link. */
const MARKDOWN_PREFIX_RE = /^\[[^[\]\n]{0,200}(?:\](?:\([^\s)]*)?)?$/;
const TRAILING = new Set([
  ".",
  ",",
  ";",
  ":",
  "!",
  "?",
  "'",
  '"',
  "]",
  "}",
  ">",
  "*",
  "_",
]);
/** A held tail longer than this is not a link in progress. */
const MAX_HOLD = 2048;

/** Length of the longest suffix of `buf` that starts a URL scheme at a word boundary. */
function partialSchemeSuffix(buf: string): number {
  const max = Math.max(...SCHEMES.map((s) => s.length)) - 1;
  for (let len = Math.min(max, buf.length); len > 0; len -= 1) {
    const tail = buf.slice(buf.length - len).toLowerCase();
    const before = buf[buf.length - len - 1];
    if (before !== undefined && /[\p{L}\p{N}]/u.test(before)) continue;
    if (SCHEMES.some((s) => s.startsWith(tail) && s.length > len)) return len;
  }
  return 0;
}

function count(text: string, ch: string): number {
  let n = 0;
  for (const c of text) if (c === ch) n += 1;
  return n;
}

/** Splits a bare URL match into the URL and the punctuation that belongs to the text. */
function trimUrl(raw: string): { url: string; rest: string } {
  let end = raw.length;
  for (;;) {
    const c = raw[end - 1];
    if (c === undefined) break;
    if (TRAILING.has(c)) {
      end -= 1;
      continue;
    }
    const head = raw.slice(0, end);
    if (c === ")" && count(head, ")") > count(head, "(")) {
      end -= 1;
      continue;
    }
    break;
  }
  return { url: raw.slice(0, end), rest: raw.slice(end) };
}

function hasHost(url: string): boolean {
  return /^https?:\/\/[^/?#\s]/i.test(url);
}

export class LinkExtractor {
  private buf = "";
  private links: ExtractedLink[] = [];

  push(delta: string): string {
    this.buf += delta;
    return this.drain(false);
  }

  end(): string {
    return this.drain(true);
  }

  /** The link for the next {@link LINK_MARK}, in text order. */
  takeLink(): ExtractedLink | undefined {
    return this.links.shift();
  }

  /** Links whose marks were never consumed (e.g. the round was cut short). */
  takeAll(): ExtractedLink[] {
    const all = this.links;
    this.links = [];
    return all;
  }

  private add(url: string, label?: string): void {
    const trimmed = label?.trim();
    this.links.push({
      url,
      ...(trimmed ? { label: trimmed } : {}),
      secure: /^https:\/\//i.test(url),
    });
  }

  private drain(final: boolean): string {
    let out = "";
    for (;;) {
      const m = START_RE.exec(this.buf);
      if (!m) {
        const hold = final ? 0 : partialSchemeSuffix(this.buf);
        out += this.buf.slice(0, this.buf.length - hold);
        this.buf = this.buf.slice(this.buf.length - hold);
        return out;
      }
      out += this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index);

      if (this.buf[0] === "[") {
        const md = MARKDOWN_RE.exec(this.buf);
        if (md && hasHost(md[2])) {
          this.add(md[2], md[1]);
          out += `${md[1]}${LINK_MARK}`;
          this.buf = this.buf.slice(md[0].length);
          continue;
        }
        if (
          !final &&
          this.buf.length <= MAX_HOLD &&
          MARKDOWN_PREFIX_RE.test(this.buf)
        ) {
          return out;
        }
        out += "[";
        this.buf = this.buf.slice(1);
        continue;
      }

      const bare = BARE_RE.exec(this.buf)!;
      if (
        !final &&
        bare[0].length === this.buf.length &&
        this.buf.length <= MAX_HOLD
      ) {
        return out;
      }
      const { url, rest } = trimUrl(bare[0]);
      if (!hasHost(url)) {
        // "https://" with nothing after it is text, not a link.
        out += bare[0];
        this.buf = this.buf.slice(bare[0].length);
        continue;
      }
      this.add(url);
      out += LINK_MARK;
      this.buf = rest + this.buf.slice(bare[0].length);
    }
  }
}

/** Number of links removed from `sentence`. */
export function countLinkMarks(sentence: string): number {
  return count(sentence, LINK_MARK);
}

/**
 * Removes the link marks from a complete sentence and the words that only
 * pointed at the link: a short label ending in a colon ("Docs: …") and a
 * dangling "at" / "via" before a link at the end. Returns "" when nothing
 * speakable is left.
 */
export function cleanLinkSentence(sentence: string): string {
  if (!sentence.includes(LINK_MARK)) return sentence;
  let t = sentence
    .replace(/(^|[.!?]\s+)[^.!?:\n]{0,40}:\s*(?=)/g, "$1")
    .replace(/\s+(?:at|via)\s*(?=[\s.!?]*$)/gi, "")
    .replace(/\s*/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/:\s*$/, ".")
    .trim();
  if (!/[\p{L}\p{N}]/u.test(t)) t = "";
  return t;
}
