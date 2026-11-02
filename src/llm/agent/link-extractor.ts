/**
 * Takes links out of streamed reply text so speech never reads a URL aloud.
 *
 * Each URL is replaced by {@link LINK_MARK}, a private-use character the
 * sentence splitter does not cut on (a URL's own dots would otherwise split a
 * sentence). When a sentence is complete, {@link cleanLinkSentence} removes
 * the marks and tidies the words around them, and the caller takes one link
 * per mark with {@link LinkExtractor.takeLink}, in order.
 *
 * Matches markdown links `[label](https://…)` (the label stays in the text),
 * bare `http(s)://…` up to the next whitespace, with trailing punctuation
 * given back to the text, and bare domains (`example.com/path`) whose last
 * label is in {@link BARE_DOMAIN_TLDS}. A bare domain becomes an `https://`
 * link; the host stays in the text (saying "example.com" is natural) and the
 * path is removed from it.
 */
export const LINK_MARK = "";

export interface ExtractedLink {
  url: string;
  label?: string;
  /** True for `https:`. Other links are removed from speech and never sent. */
  secure: boolean;
  /** For a bare domain: the text as written (`host + path`), without scheme. */
  sourceText?: string;
}

/**
 * Closed list on purpose. Country codes that are also file extensions (`md`,
 * `sh`, `py`, `rs`, `js`, `ts`, `json`, ...) are left out so `README.md`,
 * `Node.js` and `package.json` never become links.
 */
const BARE_DOMAIN_TLDS = new Set([
  "com",
  "org",
  "net",
  "dev",
  "io",
  "ai",
  "app",
  "co",
  "cloud",
  "eu",
  "de",
  "uk",
  "us",
]);
/** A host with at least two labels, then an optional path, at the buffer head. */
const DOMAIN_RE =
  /^((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}))(\/[^\s]*)?/i;
/** A buffer tail that may still grow into a domain. */
const DOMAIN_PREFIX_RE = /^[a-z0-9][a-z0-9.-]*$/i;
const ALNUM_RE = /[\p{L}\p{N}]/u;

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

/** `index` is into `lead + buf`; `off` is the length of the lead. */
type DomainHit =
  | { index: number; off: number; hold: true }
  | {
      index: number;
      off: number;
      hold: false;
      host: string;
      url: string;
    };

function hasHost(url: string): boolean {
  return /^https?:\/\/[^/?#\s]/i.test(url);
}

export class LinkExtractor {
  private buf = "";
  private links: ExtractedLink[] = [];
  /**
   * The emitted tail of the current word when it is made only of host
   * characters (`[a-z0-9.-]`), and the character before that word. A word
   * such as "voicethere" is spoken before ".dev" arrives; the lead lets the
   * domain still be recognised, so streaming gives the same result as one push.
   */
  private lead = "";
  private leadPrev = "";

  private consume(n: number): string {
    const taken = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    const s = this.lead + taken;
    let k = -1;
    for (let j = s.length - 1; j >= 0; j -= 1) {
      if (!/[a-z0-9.-]/i.test(s[j])) {
        k = j;
        break;
      }
    }
    if (k >= 0) {
      this.leadPrev = s[k];
      this.lead = s.slice(k + 1);
    } else {
      this.lead = s;
    }
    if (this.lead.length > MAX_HOLD) {
      this.lead = "";
      this.leadPrev = "x";
    }
    return taken;
  }

  /** After a link: the text now ends in a mark, so no word is open. */
  private closeWord(): void {
    this.lead = "";
    this.leadPrev = LINK_MARK;
  }

  /** The first bare domain (or possible start of one at the tail) in the buffer. */
  private scanDomain(final: boolean): DomainHit | undefined {
    const off = this.lead.length;
    const ctx = this.lead + this.buf;
    for (let i = 0; i < ctx.length; i += 1) {
      if (!/[a-z0-9]/i.test(ctx[i])) continue;
      const before = i === 0 ? this.leadPrev : ctx[i - 1];
      if (!(before === "" || /[\s("']/.test(before))) continue;
      const rest = ctx.slice(i);
      const m = DOMAIN_RE.exec(rest);
      if (!m) {
        if (
          !final &&
          rest.length <= MAX_HOLD &&
          rest.includes(".") &&
          DOMAIN_PREFIX_RE.test(rest)
        ) {
          return { index: i, hold: true, off };
        }
        continue;
      }
      const host = m[1];
      const path = m[3] ?? "";
      const end = m[0].length;
      if (!final && end === rest.length && end <= MAX_HOLD) {
        return { index: i, hold: true, off };
      }
      const next = rest[end] ?? "";
      if (!final && !path && next === "." && end + 1 === rest.length) {
        return { index: i, hold: true, off };
      }
      if (!BARE_DOMAIN_TLDS.has(m[2].toLowerCase())) continue;
      if (!path) {
        if (next && /[\p{L}\p{N}@_-]/u.test(next)) continue;
        if (next === "." && ALNUM_RE.test(rest[end + 1] ?? "")) continue;
      }
      const { url } = trimUrl(host + path);
      // The lead was already spoken; it must be part of the host.
      if (i < off && host.length < off - i) continue;
      return { index: i, hold: false, off, host, url };
    }
    return undefined;
  }

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

  private add(url: string, label?: string, sourceText?: string): void {
    const trimmed = label?.trim();
    this.links.push({
      url,
      ...(trimmed ? { label: trimmed } : {}),
      secure: /^https:\/\//i.test(url),
      ...(sourceText ? { sourceText } : {}),
    });
  }

  private drain(final: boolean): string {
    let out = "";
    for (;;) {
      const m = START_RE.exec(this.buf);
      const d = this.scanDomain(final);
      if (d && (!m || Math.max(0, d.index - d.off) < m.index)) {
        // Characters before the candidate; the lead was spoken already.
        const spoken = Math.max(0, d.off - d.index);
        out += this.consume(Math.max(0, d.index - d.off));
        if (d.hold) return out;
        this.add("https://" + d.url, d.host, d.url);
        this.consume(d.url.length - spoken);
        out += d.host.slice(spoken) + LINK_MARK;
        this.closeWord();
        continue;
      }
      if (!m) {
        const hold = final ? 0 : partialSchemeSuffix(this.buf);
        out += this.consume(this.buf.length - hold);
        return out;
      }
      out += this.consume(m.index);

      if (this.buf[0] === "[") {
        const md = MARKDOWN_RE.exec(this.buf);
        if (md && hasHost(md[2])) {
          this.add(md[2], md[1]);
          out += `${md[1]}${LINK_MARK}`;
          this.consume(md[0].length);
          this.closeWord();
          continue;
        }
        if (
          !final &&
          this.buf.length <= MAX_HOLD &&
          MARKDOWN_PREFIX_RE.test(this.buf)
        ) {
          return out;
        }
        out += this.consume(1);
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
      const { url } = trimUrl(bare[0]);
      if (!hasHost(url)) {
        // "https://" with nothing after it is text, not a link.
        out += this.consume(bare[0].length);
        continue;
      }
      this.add(url);
      out += LINK_MARK;
      this.consume(url.length);
      this.closeWord();
    }
  }
}

/** Number of links removed from `sentence`. */
export function countLinkMarks(sentence: string): number {
  return count(sentence, LINK_MARK);
}

/**
 * Removes the link marks from a complete sentence and the words that only
 * pointed at the link: a label of one to three words ending in a colon
 * ("Docs: …", "Pricing page: …") and a
 * dangling "at" / "via" before a link at the end. Returns "" when nothing
 * speakable is left.
 */
export function cleanLinkSentence(sentence: string): string {
  if (!sentence.includes(LINK_MARK)) return sentence;
  let t = sentence
    .replace(
      /(^|[.!?]\s+)(?:[\p{L}\p{N}'’-]+\s+){0,2}[\p{L}\p{N}'’-]+:\s*(?=)/gu,
      "$1",
    )
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
