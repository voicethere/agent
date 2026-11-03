import { describe, expect, it } from "vitest";
import {
  parseTemplate,
  renderTemplate,
  templateVars,
} from "../../src/flow/core/index.js";

const render = (s: string, vars: Record<string, unknown>): string =>
  renderTemplate(parseTemplate(s), (p) => vars[p]);

describe("template", () => {
  it("parses variables with whitespace and dotted paths", () => {
    const parts = parseTemplate("Hi {{ name }}, {{a.b}}!");
    expect(templateVars(parts)).toEqual(["name", "a.b"]);
    expect(render("Hi {{ name }}, {{a.b}}!", { name: "Ann", "a.b": 3 })).toBe(
      "Hi Ann, 3!",
    );
  });

  it("keeps an unclosed {{ as literal text", () => {
    expect(render("a {{ b", { b: 1 })).toBe("a {{ b");
    expect(templateVars(parseTemplate("a {{ b"))).toEqual([]);
  });

  it("keeps expressions literal (no evaluation)", () => {
    expect(render("{{ 1 + 2 }} {{a|upper}}", {})).toBe(
      "{{ 1 + 2 }} {{a|upper}}",
    );
    expect(templateVars(parseTemplate("{{ 1 + 2 }}"))).toEqual([]);
  });

  it("renders undefined/null as empty, objects as JSON, booleans as strings", () => {
    expect(render("[{{a}}][{{b}}]", { b: null })).toBe("[][]");
    expect(render("{{o}}", { o: { x: 1 } })).toBe('{"x":1}');
    expect(render("{{t}} {{n}}", { t: true, n: 0 })).toBe("true 0");
  });

  it("handles text with no placeholders and empty input", () => {
    expect(parseTemplate("")).toEqual([]);
    expect(parseTemplate("plain")).toEqual([{ kind: "text", text: "plain" }]);
  });
});
