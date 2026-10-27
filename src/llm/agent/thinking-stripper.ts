/**
 * Tag names whose content is the model's private reasoning and must never be
 * spoken, shown in chat or kept in history. Only tags seen in evidence.
 */
export const THINKING_TAGS = ["thinking"] as const;

const TAG_ALTERNATION = THINKING_TAGS.join("|");
const TAG_RE = new RegExp(`<(/?)(?:${TAG_ALTERNATION})>`, "i");
const TAG_TEXTS = THINKING_TAGS.flatMap((n) => [`<${n}>`, `</${n}>`]);

/** Length of the longest suffix of `buf` that starts a tag but is not complete. */
function partialTagSuffix(buf: string): number {
  const lower = buf.toLowerCase();
  const maxLen = Math.max(...TAG_TEXTS.map((t) => t.length)) - 1;
  for (let len = Math.min(maxLen, lower.length); len > 0; len -= 1) {
    const tail = lower.slice(lower.length - len);
    if (TAG_TEXTS.some((t) => t.startsWith(tail) && t.length > len)) return len;
  }
  return 0;
}

/**
 * Removes `<thinking>...</thinking>` spans from a stream of text deltas, even
 * when a tag is split over deltas. An opening tag without a close drops the
 * rest of the stream. Stray closing tags are dropped. Nested blocks are
 * counted.
 */
export class ThinkingStripper {
  private buf = "";
  private depth = 0;
  private stripped = 0;

  /** Characters removed so far (tags included). */
  get strippedChars(): number {
    return this.stripped;
  }

  push(delta: string): string {
    this.buf += delta;
    let out = "";
    for (;;) {
      const m = TAG_RE.exec(this.buf);
      if (!m) break;
      const before = this.buf.slice(0, m.index);
      if (this.depth === 0) out += before;
      else this.stripped += before.length;
      this.stripped += m[0].length;
      if (m[1] === "/") this.depth = Math.max(0, this.depth - 1);
      else this.depth += 1;
      this.buf = this.buf.slice(m.index + m[0].length);
    }
    const hold = partialTagSuffix(this.buf);
    const ready = this.buf.slice(0, this.buf.length - hold);
    this.buf = this.buf.slice(this.buf.length - hold);
    if (this.depth === 0) out += ready;
    else this.stripped += ready.length;
    return out;
  }

  end(): string {
    const rest = this.buf;
    this.buf = "";
    if (this.depth === 0) return rest;
    this.stripped += rest.length;
    this.depth = 0;
    return "";
  }
}

/** Strips thinking blocks from a complete text. */
export function stripThinking(text: string): {
  text: string;
  strippedChars: number;
} {
  const s = new ThinkingStripper();
  const out = s.push(text) + s.end();
  return { text: out, strippedChars: s.strippedChars };
}
