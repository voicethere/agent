// Guard for catalog id test.wall-clock-budget: a test must not assert an
// ordering bound on wall-clock or CPU time. Those bounds pass on a fast
// laptop and fail on a loaded CI runner. Assert the outcome, or drive a fake
// clock and advance it.
//
// The scan uses the TypeScript parser (no type checker) with one-file taint
// tracking by identifier name: a variable or function whose initializer/body
// contains a timing source (or a tainted name) is tainted, to a fixpoint.
// `expect(<arg>)` chained with an ordering matcher is flagged when <arg>
// contains a timing source or a tainted name. Property names are not names.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ORDERING_MATCHERS = new Set([
  "toBeLessThan",
  "toBeLessThanOrEqual",
  "toBeGreaterThan",
  "toBeGreaterThanOrEqual",
  "toBeCloseTo",
]);

const EXPECT_CALLEES = new Set(["expect", "expect.soft", "expect.poll"]);

const TIMING_CALLEES = new Set([
  "Date.now",
  "performance.now",
  "process.hrtime",
  "process.hrtime.bigint",
  "process.cpuUsage",
]);

function isTimingCall(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) && TIMING_CALLEES.has(node.expression.getText())
  );
}

/** True when `node` contains a timing source or a tainted identifier. */
function containsTiming(node: ts.Node, tainted: Set<string>): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (isTimingCall(n)) {
      found = true;
      return;
    }
    if (ts.isPropertyAccessExpression(n)) {
      // `payload.ts`: only the object side can be a tainted name.
      visit(n.expression);
      return;
    }
    if (ts.isIdentifier(n) && tainted.has(n.text)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function bindingNames(name: ts.BindingName, out: string[]): void {
  if (ts.isIdentifier(name)) {
    out.push(name.text);
    return;
  }
  for (const el of name.elements) {
    if (ts.isBindingElement(el)) bindingNames(el.name, out);
  }
}

export function findWallClockBounds(
  source: string,
  fileName: string,
): number[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const tainted = new Set<string>();

  const taintPass = (): boolean => {
    let changed = false;
    const add = (names: string[]): void => {
      for (const n of names) {
        if (!tainted.has(n)) {
          tainted.add(n);
          changed = true;
        }
      }
    };
    const visit = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && n.initializer) {
        if (containsTiming(n.initializer, tainted)) {
          const names: string[] = [];
          bindingNames(n.name, names);
          add(names);
        }
      } else if (ts.isFunctionDeclaration(n) && n.name && n.body) {
        if (containsTiming(n.body, tainted)) add([n.name.text]);
      } else if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        n.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        ts.isIdentifier(n.left) &&
        containsTiming(n.right, tainted)
      ) {
        add([n.left.text]);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return changed;
  };
  while (taintPass()) {
    /* fixpoint */
  }

  const lines: number[] = [];
  const expectArg = (expr: ts.Expression): ts.Expression | undefined => {
    let e: ts.Expression = expr;
    for (;;) {
      if (ts.isPropertyAccessExpression(e))
        e = e.expression; // .not, .resolves
      else if (ts.isCallExpression(e)) {
        return EXPECT_CALLEES.has(e.expression.getText())
          ? e.arguments[0]
          : undefined;
      } else return undefined;
    }
  };
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ORDERING_MATCHERS.has(n.expression.name.text)
    ) {
      const arg = expectArg(n.expression.expression);
      if (arg && containsTiming(arg, tainted)) {
        // Report the line of the `expect(` call itself.
        let e: ts.Expression = n.expression.expression;
        while (ts.isPropertyAccessExpression(e)) e = e.expression;
        lines.push(sf.getLineAndCharacterOfPosition(e.getStart(sf)).line + 1);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return [...new Set(lines)].sort((a, b) => a - b);
}

const here = fileURLToPath(new URL(".", import.meta.url));

describe("findWallClockBounds", () => {
  it("flags the pre-agent#176 redact shape at the expect(large / small) line", () => {
    const src = readFileSync(
      join(here, "fixtures/wall-clock/pre-agent-176-redact.ts.txt"),
      "utf8",
    );
    const lineOf =
      src.split("\n").findIndex((l) => l.includes("expect(large / small)")) + 1;
    expect(findWallClockBounds(src, "x.test.ts")).toEqual([lineOf]);
  });

  it.each([
    ["expect(Date.now() - t0).toBeLessThan(100);"],
    ["expect.soft(Date.now() - t0).toBeLessThan(100);"],
    ["const e = performance.now() - t; expect(e).toBeGreaterThan(5);"],
    ["const [s] = process.hrtime(start); expect(s).toBeLessThan(1);"],
    ["expect(process.hrtime.bigint() - t).toBeLessThan(10n);"],
  ])("flags %s", (src) => {
    expect(findWallClockBounds(src, "x.test.ts")).toEqual([1]);
  });

  it.each([
    ["let t;\nt = performance.now();\nexpect(t).toBeGreaterThan(0);", [3]],
    [
      "let total = 0;\ntotal += performance.now() - t0;\nexpect(total).toBeLessThan(5);",
      [3],
    ],
    ["expect.poll(() => Date.now() - t0).toBeLessThan(100);", [1]],
  ])("flags %j", (src, lines) => {
    expect(findWallClockBounds(src, "x.test.ts")).toEqual(lines);
  });

  it.each([
    ["expect(calls.length).toBeLessThan(3);"],
    ["expect(Date.now()).toBe(1000);"],
    ["const ts = Date.now(); expect(payload.ts).toBe(ts);"],
    ["expect(a - b).toBeLessThan(2);"],
    ["const ts = Date.now();\nexpect(payload.ts).toBeLessThan(5);"],
  ])("does not flag %s", (src) => {
    expect(findWallClockBounds(src, "x.test.ts")).toEqual([]);
  });
});

// Allowlist entries are pinned to the trimmed text of the flagged `expect`
// line, so an entry cannot hide a second bound in the same file. Every entry
// needs a concrete reason. An entry with no matching hit is stale and fails.
export type AllowEntry = { file: string; expect: string; reason: string };
export type Hit = { file: string; line: number; text: string };

export function applyAllowlist(
  hits: Hit[],
  allowlist: AllowEntry[],
): { violations: string[]; stale: string[] } {
  const key = (file: string, text: string): string => `${file}|${text.trim()}`;
  const allowed = new Set(allowlist.map((a) => key(a.file, a.expect)));
  const seen = new Set(hits.map((h) => key(h.file, h.text)));
  return {
    violations: hits
      .filter((h) => !allowed.has(key(h.file, h.text)))
      .map((h) => `${h.file}:${h.line} ${h.text.trim()}`),
    stale: allowlist
      .filter((a) => !seen.has(key(a.file, a.expect)))
      .map((a) => `${a.file}|${a.expect.trim()}`),
  };
}

const ALLOWLIST: AllowEntry[] = [];

describe("applyAllowlist", () => {
  const A = "expect(Date.now() - t).toBeLessThan(50);";
  const entry: AllowEntry = {
    file: "test/a.test.ts",
    expect: A,
    reason: "fake clock",
  };

  it("a second bound in an allowlisted file is still a violation", () => {
    const r = applyAllowlist(
      [
        { file: "test/a.test.ts", line: 3, text: `  ${A}` },
        {
          file: "test/a.test.ts",
          line: 9,
          text: "expect(Date.now() - t0).toBeLessThan(5);",
        },
      ],
      [entry],
    );
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toContain("test/a.test.ts:9");
    expect(r.stale).toEqual([]);
  });

  it("an entry with no matching hit is stale", () => {
    const r = applyAllowlist([], [entry]);
    expect(r.violations).toEqual([]);
    expect(r.stale).toHaveLength(1);
  });
});

function listTests(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === "fixtures") continue;
      listTests(p, out);
    } else if (name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

describe("repo scan: no wall-clock or CPU-time bounds in test assertions", () => {
  const self = fileURLToPath(import.meta.url);
  const hits: Hit[] = [];
  for (const file of listTests(here)) {
    if (file === self) continue;
    const source = readFileSync(file, "utf8");
    const srcLines = source.split("\n");
    for (const line of findWallClockBounds(source, file)) {
      hits.push({
        file: relative(join(here, ".."), file),
        line,
        text: srcLines[line - 1] ?? "",
      });
    }
  }
  const result = applyAllowlist(hits, ALLOWLIST);

  it("has no unallowlisted hits", () => {
    expect(result.violations).toEqual([]);
  });

  it("has no stale allowlist entries and every entry has a reason", () => {
    expect(result.stale).toEqual([]);
    expect(ALLOWLIST.filter((a) => a.reason.trim() === "")).toEqual([]);
  });
});
