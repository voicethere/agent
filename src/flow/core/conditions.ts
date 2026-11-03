import type { FlowRule, FlowRuleGroup } from "./types.js";

export type FlowLookup = (path: string) => unknown;

function isNumeric(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  return typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v));
}

function isPresent(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "";
}

function looseEquals(a: unknown, b: unknown): boolean {
  if (a === undefined || a === null) return false;
  if (isNumeric(a) && isNumeric(b)) return Number(a) === Number(b);
  return String(a) === String(b);
}

function compileRule(rule: FlowRule): (lookup: FlowLookup) => boolean {
  const { var: name, op, value } = rule;
  switch (op) {
    case "eq":
      return (l) => looseEquals(l(name), value);
    case "ne":
      return (l) => !looseEquals(l(name), value);
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return (l) => {
        const a = l(name);
        if (!isNumeric(a) || !isNumeric(value)) return false;
        const x = Number(a);
        const y = Number(value);
        if (op === "gt") return x > y;
        if (op === "gte") return x >= y;
        if (op === "lt") return x < y;
        return x <= y;
      };
    case "contains":
      return (l) => {
        const a = l(name);
        if (typeof a === "string") {
          if (value === undefined || value === null) return false;
          return a.toLowerCase().includes(String(value).toLowerCase());
        }
        if (Array.isArray(a)) return a.some((el) => looseEquals(el, value));
        return false;
      };
    case "exists":
      return (l) => isPresent(l(name));
    default:
      return () => false;
  }
}

/** Compiles a rule or an all/any group into a predicate over a lookup. */
export function compileRuleGroup(
  group: FlowRuleGroup | FlowRule,
): (lookup: FlowLookup) => boolean {
  if ("var" in group) return compileRule(group);
  if ("all" in group) {
    const subs = group.all.map(compileRuleGroup);
    return (l) => subs.every((s) => s(l));
  }
  const subs = group.any.map(compileRuleGroup);
  return (l) => subs.some((s) => s(l));
}
