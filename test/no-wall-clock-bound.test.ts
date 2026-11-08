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

const TIMING_CALLEES = new Set([
  "Date.now",
  "performance.now",
  "process.hrtime",
  "process.hrtime.bigint",
  "process.cpuUsage",
]);

function isTimingCall(node: ts.Node): boolean {
  return ts.isCallExpression(node) && TIMING_CALLEES.has(node.expression.getText());
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

export function findWallClockBounds(source: string, fileName: string): number[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
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
      if (ts.isPropertyAccessExpression(e)) e = e.expression; // .not, .resolves
      else if (ts.isCallExpression(e)) {
        return e.expression.getText() === "expect" ? e.arguments[0] : undefined;
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
  return lines;
}

const here = fileURLToPath(new URL(".", import.meta.url));

describe("findWallClockBounds", () => {
  it("flags the pre-agent#176 redact shape at the expect(large / small) line", () => {
    const src = readFileSync(
      join(here, "fixtures/wall-clock/pre-agent-176-redact.ts.txt"),
      "utf8",
    );
    const lineOf = src.split("\n").findIndex((l) => l.includes("expect(large / small)")) + 1;
    expect(findWallClockBounds(src, "x.test.ts")).toEqual([lineOf]);
  });

  it.each([
    ["expect(Date.now() - t0).toBeLessThan(100);"],
    ["const e = performance.now() - t; expect(e).toBeGreaterThan(5);"],
    ["const [s] = process.hrtime(start); expect(s).toBeLessThan(1);"],
    ["expect(process.hrtime.bigint() - t).toBeLessThan(10n);"],
  ])("flags %s", (src) => {
    expect(findWallClockBounds(src, "x.test.ts")).toEqual([1]);
  });

  it.each([
    ["expect(calls.length).toBeLessThan(3);"],
    ["expect(Date.now()).toBe(1000);"],
    ["const ts = Date.now(); expect(payload.ts).toBe(ts);"],
    ["expect(a - b).toBeLessThan(2);"],
  ])("does not flag %s", (src) => {
    expect(findWallClockBounds(src, "x.test.ts")).toEqual([]);
  });
});

// File-level allowlist; every entry needs a concrete reason. A stale entry
// (file no longer has a hit) fails the scan.
const ALLOWLIST: { file: string; reason: string }[] = [
  {
    file: "test/llm-agent-template.test.ts",
    reason:
      "false positive: `base` is tainted only because its options hold a Date.now()-derived Redis namespace; the flagged expect asserts an indexed chunk count, not time",
  },
];

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
  const hits = new Map<string, number[]>();
  for (const file of listTests(here)) {
    if (file === self) continue;
    const lines = findWallClockBounds(readFileSync(file, "utf8"), file);
    if (lines.length > 0) hits.set(relative(join(here, ".."), file), lines);
  }
  const allowed = new Set(ALLOWLIST.map((a) => a.file));

  it("has no unallowlisted hits", () => {
    const bad = [...hits].filter(([f]) => !allowed.has(f)).map(([f, l]) => `${f}:${l.join(",")}`);
    expect(bad).toEqual([]);
  });

  it("has no stale allowlist entries and every entry has a reason", () => {
    const stale = ALLOWLIST.filter((a) => !hits.has(a.file)).map((a) => a.file);
    expect(stale).toEqual([]);
    expect(ALLOWLIST.filter((a) => a.reason.trim() === "")).toEqual([]);
  });
});
