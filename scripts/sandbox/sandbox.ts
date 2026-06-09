/**
 * Node --permission flags for the customer child process.
 *
 * Keep in sync with the agent runner `src/child/sandbox.ts`.
 */

import { dirname, resolve } from "node:path";

/**
 * Node --permission flags for the customer child: no subprocesses, no fs writes.
 * `fs` read is limited to the loader + bundle directories (no `--allow-child-process`).
 */
export function buildChildExecArgv(options: {
  loaderDir: string;
  bundlePath: string;
}): string[] {
  const readDirs = new Set<string>([
    resolve(options.loaderDir),
    resolve(dirname(options.bundlePath)),
  ]);

  return [
    "--permission",
    ...[...readDirs].map((dir) => `--allow-fs-read=${dir}`),
  ];
}
