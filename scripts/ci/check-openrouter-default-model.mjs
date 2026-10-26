// Release check: the OpenRouter default model in the catalog must be listed by
// OpenRouter and support tools. Uses only GET /api/v1/models, fields data[].id
// and data[].supported_parameters. Needs network, so it is not part of PR CI.
import { readFileSync } from "node:fs";

const catalogUrl = new URL("../../src/llm/catalog.ts", import.meta.url);
const source = readFileSync(catalogUrl, "utf8");
const block = source.match(/openrouter:\s*\{([\s\S]*?)\n  \},/);
const model = block?.[1].match(/defaultModel:\s*"([^"]+)"/)?.[1];
if (!model) {
  console.error(
    "openrouter default model check: no defaultModel found for openrouter in src/llm/catalog.ts",
  );
  process.exit(1);
}

let body;
try {
  const res = await fetch("https://openrouter.ai/api/v1/models", {
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  body = await res.json();
} catch (err) {
  console.error(
    `openrouter default model check: could not list models: ${err instanceof Error ? err.message : "unknown error"}`,
  );
  process.exit(1);
}

const entry = Array.isArray(body?.data)
  ? body.data.find((m) => m.id === model)
  : undefined;
if (!entry) {
  console.error(
    `openrouter default model check: ${model} is not listed by OpenRouter`,
  );
  process.exit(1);
}
if (
  !Array.isArray(entry.supported_parameters) ||
  !entry.supported_parameters.includes("tools")
) {
  console.error(
    `openrouter default model check: ${model} does not list "tools" in supported_parameters`,
  );
  process.exit(1);
}
console.log(
  `openrouter default model check: ${model} ok (listed, supports tools)`,
);
