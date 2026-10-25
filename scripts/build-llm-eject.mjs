#!/usr/bin/env node
/**
 * Writes eject/llm/loop.ts: a copy of src/llm/agent/create-llm-agent.ts whose
 * relative imports are rewritten to the package entry points, so a customer
 * can copy the file into a project and edit the turn loop.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcFile = join(root, "src/llm/agent/create-llm-agent.ts");
const source = readFileSync(srcFile, "utf8");
const version = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
).version;

function packageModule(specifier) {
  const abs = resolve(dirname(srcFile), specifier.replace(/\.js$/, ""));
  const rel = relative(join(root, "src"), abs).split("\\").join("/");
  if (rel === "runtime" || rel === "index") return "@voicethere/agent";
  if (rel === "llm" || rel.startsWith("llm/")) return "@voicethere/agent/llm";
  throw new Error(`eject: cannot map import ${specifier} (${rel})`);
}

const importRe = /^import\s+(type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)";\n/gm;
const modules = new Map(); // module -> Set of specifier strings
const order = [];
const builtins = [];

const body = source.replace(importRe, (_all, typeOnly, names, specifier) => {
  const list = names
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean)
    .map((n) => (typeOnly ? `type ${n}` : n));
  if (!specifier.startsWith(".")) {
    builtins.push(`import { ${list.join(", ")} } from "${specifier}";`);
    return "";
  }
  const mod = packageModule(specifier);
  if (!modules.has(mod)) {
    modules.set(mod, new Set());
    order.push(mod);
  }
  for (const n of list) modules.get(mod).add(n);
  return "";
});

if (/^import\s/m.test(body)) {
  throw new Error("eject: unhandled import form left in the loop source");
}

const lines = [
  `// Copied from @voicethere/agent ${version}. Package updates no longer change this file.`,
  ...builtins,
  ...order.map((mod) => {
    const names = [...modules.get(mod)].sort((a, b) =>
      a.replace(/^type /, "").localeCompare(b.replace(/^type /, "")),
    );
    return `import {\n${names.map((n) => `  ${n},`).join("\n")}\n} from "${mod}";`;
  }),
];

mkdirSync(join(root, "eject/llm"), { recursive: true });
writeFileSync(
  join(root, "eject/llm/loop.ts"),
  `${lines.join("\n")}\n${body.replace(/^\n+/, "\n")}`,
);
