import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:fs")>();
  return {
    ...mod,
    existsSync: vi.fn(mod.existsSync),
  };
});

import * as fs from "node:fs";

import { loadTemplateWorkspaceSources } from "../src/templates/index.js";

describe("loadTemplateWorkspaceSources missing file", () => {
  afterEach(() => {
    vi.mocked(fs.existsSync).mockReset();
  });

  it("throws when a template source file is missing", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(() => loadTemplateWorkspaceSources("echo")).toThrow(
      /Template source not found for echo:/,
    );
  });
});
