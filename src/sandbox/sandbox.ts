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
 * Node 26+ gates outbound network under `--permission`; boolean `--allow-net` restores
 * fetch/HTTPS for customer LLM calls. Optional `allowNetHosts` emits forward-compatible
 * `--allow-net=<host>` entries for project Redis when Node adds host-scoped net ACLs.
 */
export function buildChildExecArgv(options: {
  loaderDir: string;
  bundlePath: string;
  /** When true (default), emit boolean `--allow-net` for HTTPS / LLM egress (Node 26+). */
  allowInternet?: boolean;
  /** Hostnames (optionally `host:port`) for future scoped `--allow-net` (e.g. project Redis). */
  allowNetHosts?: string[];
}): string[] {
  const readDirs = collectAllowFsReadDirs([
    options.loaderDir,
    dirname(options.bundlePath),
    options.bundlePath,
  ]);

  const allowNetFlags: string[] = [];
  if (options.allowInternet !== false) {
    allowNetFlags.push("--allow-net");
  }
  for (const host of options.allowNetHosts ?? []) {
    const trimmed = host.trim();
    if (trimmed.length > 0) {
      allowNetFlags.push(`--allow-net=${trimmed}`);
    }
  }

  return [
    "--permission",
    ...readDirs.map((dir) => `--allow-fs-read=${dir}`),
    ...allowNetFlags,
  ];
}
