import { describe, expect, it } from "vitest";
import { compileRuleGroup } from "../../src/flow/core/index.js";

const run = (rule: any, vars: Record<string, unknown>): boolean =>
  compileRuleGroup(rule)((p) => vars[p]);

describe("conditions", () => {
  const table: [string, any, Record<string, unknown>, boolean][] = [
    [
      "eq numeric strings",
      { var: "a", op: "eq", value: 5 },
      { a: "5.0" },
      true,
    ],
    ["eq numbers differ", { var: "a", op: "eq", value: 5 }, { a: 6 }, false],
    ["eq strings", { var: "a", op: "eq", value: "x" }, { a: "x" }, true],
    [
      "eq strings case-sensitive",
      { var: "a", op: "eq", value: "x" },
      { a: "X" },
      false,
    ],
    ["eq missing", { var: "a", op: "eq", value: "x" }, {}, false],
    ["ne equal", { var: "a", op: "ne", value: "x" }, { a: "x" }, false],
    ["ne missing", { var: "a", op: "ne", value: "x" }, {}, true],
    ["gt true", { var: "a", op: "gt", value: 1 }, { a: 2 }, true],
    ["gt equal", { var: "a", op: "gt", value: 2 }, { a: 2 }, false],
    ["gte equal", { var: "a", op: "gte", value: 2 }, { a: "2" }, true],
    ["lt true", { var: "a", op: "lt", value: 3 }, { a: 2 }, true],
    ["lt equal", { var: "a", op: "lt", value: 2 }, { a: 2 }, false],
    ["lte equal", { var: "a", op: "lte", value: 2 }, { a: 2 }, true],
    [
      "gt non-numeric is false",
      { var: "a", op: "gt", value: 1 },
      { a: "abc" },
      false,
    ],
    [
      "lt non-numeric is false",
      { var: "a", op: "lt", value: 1 },
      { a: "abc" },
      false,
    ],
    ["gt missing is false", { var: "a", op: "gt", value: 1 }, {}, false],
    [
      "contains string ci",
      { var: "a", op: "contains", value: "ELL" },
      { a: "Hello" },
      true,
    ],
    [
      "contains string miss",
      { var: "a", op: "contains", value: "z" },
      { a: "Hello" },
      false,
    ],
    [
      "contains array",
      { var: "a", op: "contains", value: 2 },
      { a: [1, 2] },
      true,
    ],
    [
      "contains array miss",
      { var: "a", op: "contains", value: 3 },
      { a: [1, 2] },
      false,
    ],
    [
      "contains number is false",
      { var: "a", op: "contains", value: 1 },
      { a: 1 },
      false,
    ],
    ["exists value", { var: "a", op: "exists" }, { a: 0 }, true],
    ["exists empty string", { var: "a", op: "exists" }, { a: "" }, false],
    ["exists null", { var: "a", op: "exists" }, { a: null }, false],
    ["exists undefined", { var: "a", op: "exists" }, {}, false],
  ];
  for (const [name, rule, vars, want] of table) {
    it(name, () => expect(run(rule, vars)).toBe(want));
  }

  it("evaluates nested all/any groups", () => {
    const g = {
      all: [
        { var: "a", op: "gt", value: 1 },
        {
          any: [
            { var: "b", op: "eq", value: "x" },
            { var: "c", op: "exists" },
          ],
        },
      ],
    };
    expect(run(g, { a: 2, b: "x" })).toBe(true);
    expect(run(g, { a: 2, c: "y" })).toBe(true);
    expect(run(g, { a: 2 })).toBe(false);
    expect(run(g, { a: 1, b: "x" })).toBe(false);
  });
});
