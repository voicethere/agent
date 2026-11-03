function parseIpv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const n = m.slice(1).map(Number);
  return n.every((x) => x <= 255) ? n : null;
}

function privateIpv4(n: number[]): boolean {
  const [a, b] = n as [number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** Eight 16-bit groups, or null when the literal does not parse. */
function parseIpv6(host: string): number[] | null {
  let h = host;
  const tail = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (tail) {
    const v4 = parseIpv4(tail[1]!);
    if (!v4) return null;
    const hi = ((v4[0]! << 8) | v4[1]!).toString(16);
    const lo = ((v4[2]! << 8) | v4[3]!).toString(16);
    h = h.slice(0, h.length - tail[1]!.length) + `${hi}:${lo}`;
  }
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const toGroups = (s: string): number[] | null => {
    if (s === "") return [];
    const out: number[] = [];
    for (const g of s.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(halves[0]!);
  if (!head) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const rest = toGroups(halves[1]!);
  if (!rest) return null;
  const fill = 8 - head.length - rest.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...rest];
}

/**
 * True for literal hosts that must never be fetched: localhost, loopback,
 * private, link-local, CGNAT and unspecified IPv4/IPv6 (including IPv4-mapped
 * forms). Ambiguous numeric IPv4 spellings (`2130706433`, `0x7f.1`, `127.1`)
 * count as private. Other hostnames return false: DNS is enforced by runner
 * egress at connect time.
 */
export function isPrivateHostLiteral(host: string): boolean {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  while (h.endsWith(".")) h = h.slice(0, -1);
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.includes(":")) {
    const g = parseIpv6(h);
    if (!g) return true;
    if (g.every((x) => x === 0)) return true;
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true;
    if ((g[0]! & 0xfe00) === 0xfc00) return true;
    if ((g[0]! & 0xffc0) === 0xfe80) return true;
    const embedded =
      g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff
        ? true
        : g.slice(0, 6).every((x) => x === 0);
    if (embedded) {
      return privateIpv4([g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255]);
    }
    return false;
  }
  const v4 = parseIpv4(h);
  if (v4) return privateIpv4(v4);
  if (/^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+))*$/.test(h)) return true;
  return false;
}
