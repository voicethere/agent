import { describe, expect, it } from "vitest";
import { validateFlow } from "../../src/flow/core/index.js";
import { baseFlow } from "./fixtures.js";

const routeNode = (f: any): any => f.nodes.find((n: any) => n.type === "route");

describe("route classifier model", () => {
  it("a route without a classifier entry is valid when models.default exists", () => {
    const f = baseFlow();
    delete f.models.classifier;
    expect(validateFlow(f).errors).toEqual([]);
  });

  it("FLOW_MODEL_UNKNOWN when neither classifier nor default resolves", () => {
    const f = baseFlow();
    delete f.models.classifier;
    delete f.models.default;
    const codes = validateFlow(f).errors.map((e) => e.code);
    expect(codes).toContain("FLOW_MODEL_UNKNOWN");
  });

  it("an explicit missing model on the route is still unknown", () => {
    const f = baseFlow();
    routeNode(f).model = "ghost";
    const r = validateFlow(f);
    expect(
      r.errors.some(
        (e) => e.code === "FLOW_MODEL_UNKNOWN" && e.nodeId === routeNode(f).id,
      ),
    ).toBe(true);
  });
});
