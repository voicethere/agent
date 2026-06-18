/**
 * Node --permission flags for the customer child process.
 *
 * Keep in sync with the agent runner `src/child/sandbox.ts`.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Collect unique fs-read allowlist paths (resolved + realpath for /var/run → /run symlinks). */
export function collectAllowFsReadDirs(paths: string[]): string[] {
  const readDirs = new Set<string>();
  for (const raw of paths) {
    const resolved = resolve(raw);
    readDirs.add(resolved);
    try {
      if (existsSync(resolved)) {
        readDirs.add(realpathSync(resolved));
      }
    } catch {
      // ignore
    }
  }
  return [...readDirs];
}

/**
 * Node --permission flags for the customer child: no subprocesses, no fs writes.
 * `fs` read is limited to the loader + bundle directories (no `--allow-child-process`).
 */
export function buildChildExecArgv(options: {
  loaderDir: string;
  bundlePath: string;
}): string[] {
  const readDirs = collectAllowFsReadDirs([
    options.loaderDir,
    dirname(options.bundlePath),
    options.bundlePath,
  ]);

  return [
    "--permission",
    ...readDirs.map((dir) => `--allow-fs-read=${dir}`),
  ];
}
