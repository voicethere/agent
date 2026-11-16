import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildChatCompletionParams } from "../../src/llm/openai-provider.js";
import type { LlmRequest } from "../../src/llm/types.js";

export interface RequestFixtureMeta {
  template: string;
  promise: string;
  shape: string;
  promptSha256: string;
}

/**
 * Writes the exact chat/completions body the runtime would send for `req`.
 * No-op unless `WRITE_INCIDENT_FIXTURE` names a directory. `_label` is for the
 * caller's own readability and is not part of the file name.
 */
export function writeRequestFixture(
  _label: string,
  req: LlmRequest,
  meta: RequestFixtureMeta,
): void {
  const dir = process.env.WRITE_INCIDENT_FIXTURE;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${meta.template}-${meta.promise}-${meta.shape}.json`);
  const out = {
    meta: { ...meta, model: req.model, toolChoice: req.toolChoice },
    body: buildChatCompletionParams(req, "openrouter"),
  };
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
}
