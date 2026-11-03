/**
 * RFC 6901 JSON Pointer lookup. Returns undefined when the pointer is
 * malformed or does not resolve. Only own properties are read.
 */
export function resolvePointer(doc: unknown, pointer: string): unknown {
  if (pointer === "") return doc;
  if (!pointer.startsWith("/")) return undefined;
  let cur: unknown = doc;
  for (const raw of pointer.slice(1).split("/")) {
    const token = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cur === null || typeof cur !== "object") return undefined;
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9]\d*)$/.test(token)) return undefined;
      cur = cur[Number(token)];
    } else {
      if (!Object.hasOwn(cur, token)) return undefined;
      cur = (cur as Record<string, unknown>)[token];
    }
  }
  return cur;
}
