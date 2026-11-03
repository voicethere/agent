import { describe, expect, it } from "vitest";
import {
  FLOW_MIGRATIONS,
  migrateFlow,
  migrateFlowWith,
  type FlowMigration,
} from "../../src/flow/core/index.js";
import { baseFlow } from "./fixtures.js";

describe("migrateFlow", () => {
  it("has no migrations for schema v1", () => {
    expect(FLOW_MIGRATIONS).toEqual([]);
  });

  it("leaves a v1 document untouched (same object)", () => {
    const doc = baseFlow();
    const r = migrateFlow(doc);
    expect(r.migrated).toBe(false);
    expect(r.from).toBe(1);
    expect(r.doc).toBe(doc);
  });

  it("runs a v0 -> v1 migration once and does not mutate the input", () => {
    let calls = 0;
    const list: FlowMigration[] = [
      {
        from: 0,
        to: 1,
        up(d) {
          calls++;
          return { ...d, start: d.begin, begin: undefined };
        },
      },
    ];
    const input = { version: 0, begin: "a", nodes: [] };
    const r = migrateFlowWith(list, input);
    expect(calls).toBe(1);
    expect(r.migrated).toBe(true);
    expect(r.from).toBe(0);
    expect((r.doc as any).version).toBe(1);
    expect((r.doc as any).start).toBe("a");
    expect(input.version).toBe(0);
    const again = migrateFlowWith(list, r.doc);
    expect(again.migrated).toBe(false);
    expect(calls).toBe(1);
  });

  it("chains migrations up to the highest target", () => {
    const list: FlowMigration[] = [
      { from: 1, to: 2, up: (d) => ({ ...d, a: 1 }) },
      { from: 2, to: 3, up: (d) => ({ ...d, b: 2 }) },
    ];
    const r = migrateFlowWith(list, { version: 1 });
    expect(r.doc).toEqual({ version: 3, a: 1, b: 2 });
  });

  it("returns a newer version unchanged (validation reports it)", () => {
    const doc = { version: 2, nodes: [] };
    const r = migrateFlow(doc);
    expect(r.migrated).toBe(false);
    expect(r.doc).toBe(doc);
    expect(r.from).toBe(2);
  });

  it("returns non-objects and version-less documents unchanged", () => {
    expect(migrateFlow(null)).toEqual({
      doc: null,
      migrated: false,
      from: null,
    });
    const noVersion = { nodes: [] };
    expect(
      migrateFlowWith([{ from: 0, to: 1, up: (d) => d }], noVersion).migrated,
    ).toBe(false);
  });
});
