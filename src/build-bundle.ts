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
    target: "node22",
    logLevel: "warning",
  });
}
