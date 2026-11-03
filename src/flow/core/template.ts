export type TemplatePart =
  { kind: "text"; text: string } | { kind: "var"; name: string };

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_-]+)*$/;

/**
 * Splits `{{name}}` / `{{a.b}}` placeholders. Whitespace inside the braces is
 * trimmed. An unclosed `{{` and anything that is not a plain name (an
 * expression) stays literal text. There is no expression language.
 */
export function parseTemplate(s: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  const pushText = (text: string): void => {
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last && last.kind === "text") last.text += text;
    else parts.push({ kind: "text", text });
  };
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf("{{", i);
    if (open < 0) {
      pushText(s.slice(i));
      break;
    }
    const close = s.indexOf("}}", open + 2);
    if (close < 0) {
      pushText(s.slice(i));
      break;
    }
    pushText(s.slice(i, open));
    const inner = s.slice(open + 2, close);
    const name = inner.trim();
    if (VAR_NAME.test(name)) parts.push({ kind: "var", name });
    else pushText(s.slice(open, close + 2));
    i = close + 2;
  }
  return parts;
}

export function templateVars(parts: TemplatePart[]): string[] {
  const out: string[] = [];
  for (const p of parts) if (p.kind === "var") out.push(p.name);
  return out;
}

export function renderTemplate(
  parts: TemplatePart[],
  lookup: (path: string) => unknown,
): string {
  let out = "";
  for (const p of parts) {
    if (p.kind === "text") {
      out += p.text;
      continue;
    }
    const v = lookup(p.name);
    if (v === undefined || v === null) continue;
    if (typeof v === "object") out += JSON.stringify(v);
    else out += String(v);
  }
  return out;
}
