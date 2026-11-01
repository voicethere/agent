import { afterEach, describe, expect, it, vi } from "vitest";

const KEY = Symbol.for("voicethere.agent.currentSessionId");
const g = globalThis as unknown as Record<symbol, unknown>;

async function importFreshRuntime(previous: () => unknown): Promise<unknown> {
  g[KEY] = previous;
  vi.resetModules();
  await import("../src/runtime.js");
  return g[KEY];
}

afterEach(() => {
  delete g[KEY];
  vi.resetModules();
});

describe("current session id getter chaining", () => {
  it("chains to a getter installed by an earlier runtime copy", async () => {
    const getter = (await importFreshRuntime(
      () => "prev-session",
    )) as () => unknown;
    expect(getter()).toBe("prev-session");
  });

  it("a throwing earlier getter yields undefined", async () => {
    const getter = (await importFreshRuntime(() => {
      throw new Error("x");
    })) as () => unknown;
    expect(() => getter()).not.toThrow();
    expect(getter()).toBeUndefined();
  });

  it("a non-string earlier getter yields undefined", async () => {
    const getter = (await importFreshRuntime(() => 42)) as () => unknown;
    expect(getter()).toBeUndefined();
  });
});
