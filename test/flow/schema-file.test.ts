import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { FLOW_JSON_SCHEMA } from "../../src/flow/core/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("flow schema file", () => {
  it("the flow JSON schema file matches FLOW_JSON_SCHEMA", () => {
    const file = join(root, "schema/voicethere.flow.schema.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(
      JSON.parse(JSON.stringify(FLOW_JSON_SCHEMA)),
    );
  });

  it("@voicethere/agent/flow/schema.json resolves to the committed file", () => {
    const req = createRequire(join(root, "package.json"));
    expect(req.resolve("@voicethere/agent/flow/schema.json")).toMatch(
      /schema[\\/]voicethere\.flow\.schema\.json$/,
    );
  });
});
