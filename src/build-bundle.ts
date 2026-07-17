import { builtinModules } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import * as esbuild from "esbuild";

export interface BuildAgentBundleOptions {
  /** Agent source entry (TypeScript or JavaScript). */
  entry: string;
  /** Output bundle path (typically `dist/agent.js`). */
  outfile: string;
  /** Working directory for relative paths. Defaults to `process.cwd()`. */
  cwd?: string;
}

const NODE_BUILTIN_MODULE_IDS = new Set<string>([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

/** Lets bundled CJS deps (ioredis) call `require("events")` under ESM output. */
const AGENT_BUNDLE_BANNER = `import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
`;

function isNodeBuiltinModuleId(path: string): boolean {
  return NODE_BUILTIN_MODULE_IDS.has(path);
}

/** Optional deps that ioredis/debug resolve dynamically; stub so bundles stay self-contained. */
const BUNDLE_STUB_MODULES: Record<string, string> = {
  "supports-color": "export default false;",
};

function bundleStubPlugin(): esbuild.Plugin {
  return {
    name: "agent-bundle-stub",
    setup(build) {
      build.onResolve({ filter: /^supports-color$/ }, () => ({
        path: "supports-color",
        namespace: "agent-bundle-stub",
      }));
      build.onLoad({ filter: /.*/, namespace: "agent-bundle-stub" }, (args) => ({
        contents: BUNDLE_STUB_MODULES[args.path] ?? "export {};",
        loader: "js",
      }));
    },
  };
}

/**
 * Keep Node built-ins external so bundled CJS deps (e.g. ioredis) use runtime
 * `import` / `createRequire` instead of esbuild's broken `__require` shim
 * ("Dynamic require of \"events\" is not supported").
 */
export function nodeBuiltinExternalPlugin(): esbuild.Plugin {
  return {
    name: "node-builtin-external",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (!isNodeBuiltinModuleId(args.path)) {
          return undefined;
        }
        return { path: args.path, external: true };
      });
    },
  };
}

/**
 * Bundle customer agent source into a single ESM file for the sandboxed child.
 */
export async function buildAgentBundle(
  options: BuildAgentBundleOptions,
): Promise<esbuild.BuildResult> {
  const cwd = options.cwd ?? process.cwd();
  const entry = resolve(cwd, options.entry);
  const outfile = resolve(cwd, options.outfile);

  if (!existsSync(entry)) {
    throw new Error(`Entry not found: ${entry}`);
  }

  mkdirSync(dirname(outfile), { recursive: true });

  return esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    target: "node26",
    logLevel: "warning",
    banner: { js: AGENT_BUNDLE_BANNER },
    plugins: [nodeBuiltinExternalPlugin(), bundleStubPlugin()],
  });
}
