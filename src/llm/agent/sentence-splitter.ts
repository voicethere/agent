const ABBREVIATIONS = new Set([
  "e.g",
  "i.e",
  "mr",
  "mrs",
  "ms",
  "dr",
  "st",
  "vs",
  "etc",
]);

const SOFT_LIMIT = 220;
const CUT_AT = 200;

function isSpace(c: string | undefined): boolean {
  return c !== undefined && /\s/.test(c);
}

/** The word (letters and inner dots) that ends right before index `dot`. */
function wordBefore(buf: string, dot: number): string {
  let i = dot;
  while (i > 0 && /[A-Za-z.]/.test(buf[i - 1])) i -= 1;
  return buf.slice(i, dot).replace(/^\.+/, "").toLowerCase();
}

/**
 * Cuts a stream of text deltas into sentences that can be spoken one by one.
 */
export class SentenceSplitter {
  private buf = "";

  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    let i = 0;
    while (i < this.buf.length) {
      const c = this.buf[i];
      let cut = -1;
      if (c === "\n") {
        cut = i + 1;
      } else if (c === "." || c === "!" || c === "?" || c === "…") {
        const next = this.buf[i + 1];
        if (next === undefined) break; // need one more char to decide
        if (isSpace(next)) {
          if (c === "." && this.isAbbreviation(i)) {
            i += 1;
            continue;
          }
          if (c === "." && wordBefore(this.buf, i) === "no") {
            let j = i + 1;
            while (j < this.buf.length && isSpace(this.buf[j])) j += 1;
            if (j >= this.buf.length) break; // wait for the next char
            if (/\d/.test(this.buf[j])) {
              i += 1;
              continue;
            }
          }
          cut = i + 1;
        }
      }
      if (cut >= 0) {
        const sentence = this.buf.slice(0, cut).trim();
        this.buf = this.buf.slice(cut);
        i = 0;
        if (sentence) out.push(sentence);
        continue;
      }
      i += 1;
    }
    while (this.buf.length > SOFT_LIMIT) {
      let at = this.buf.lastIndexOf(" ", CUT_AT);
      if (at <= 0) at = CUT_AT;
      const piece = this.buf.slice(0, at).trim();
      this.buf = this.buf.slice(at);
      if (piece) out.push(piece);
    }
    return out;
  }

  end(): string[] {
    const rest = this.buf.trim();
    this.buf = "";
    return rest ? [rest] : [];
  }

  private isAbbreviation(dot: number): boolean {
    return ABBREVIATIONS.has(wordBefore(this.buf, dot));
  }
}
