#!/usr/bin/env node
/**
 * Customer-facing CLI — bundle and verify voice agents for VoiceThere.
 *
 *   npx @voicethere/agent build
 *   npx @voicethere/agent verify
 */

import { buildAgentBundle } from "./build-bundle.js";
import {
  DEFAULT_VERIFY_BUNDLE,
  DEFAULT_VERIFY_ENTRY,
} from "./verify/lib.js";
import {
  formatVerifyFailure,
  runAgentVerify,
} from "./verify/run-verify.js";

const DEFAULT_ENTRY = DEFAULT_VERIFY_ENTRY;
const DEFAULT_OUTFILE = DEFAULT_VERIFY_BUNDLE;

function printHelp(): void {
  process.stdout.write(`@voicethere/agent — bundle and verify your voice agent

Usage:
  npx @voicethere/agent
  npx @voicethere/agent build [options]
  npx @voicethere/agent verify [options]

Commands:
  build    Bundle agent source to a single ESM file
  verify   Build (optional) and run static bundle checks

Build options:
  --entry, -e <path>     Agent entry file (default: ${DEFAULT_ENTRY})
  --outfile, -o <path>   Output bundle (default: ${DEFAULT_OUTFILE})

Verify options:
  --entry, -e <path>     Entry for build step (default: ${DEFAULT_ENTRY})
  --outfile, -o <path>   Bundle output path (default: ${DEFAULT_OUTFILE})
  --bundle, -b <path>    Bundle to verify (default: ${DEFAULT_OUTFILE})
  --no-build             Skip build; verify an existing bundle only
  --help, -h             Show this help

Examples:
  npm install @voicethere/agent
  npx @voicethere/agent build --entry src/agent.ts --outfile dist/agent.js
  npx @voicethere/agent verify
  npx @voicethere/agent verify --no-build --bundle dist/agent.js
`);
}

interface BuildCliOptions {
  entry: string;
  outfile: string;
}

interface VerifyCliOptions extends BuildCliOptions {
  bundlePath: string;
  noBuild: boolean;
}

function parseBuildArgs(argv: string[]): BuildCliOptions {
  let entry = DEFAULT_ENTRY;
  let outfile = DEFAULT_OUTFILE;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--entry" || arg === "-e") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error(`${arg} requires a path`);
      }
      entry = value;
      i += 1;
      continue;
    }
    if (arg === "--outfile" || arg === "-o") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error(`${arg} requires a path`);
      }
      outfile = value;
      i += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return { entry, outfile };
}

function parseVerifyArgs(argv: string[]): VerifyCliOptions {
  let entry = DEFAULT_ENTRY;
  let outfile = DEFAULT_OUTFILE;
  let noBuild = false;
  let bundleArg: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--no-build") {
      noBuild = true;
      continue;
    }
    if (arg === "--entry" || arg === "-e") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error(`${arg} requires a path`);
      }
      entry = value;
      i += 1;
      continue;
    }
    if (arg === "--outfile" || arg === "-o") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error(`${arg} requires a path`);
      }
      outfile = value;
      i += 1;
      continue;
    }
    if (arg === "--bundle" || arg === "-b") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error(`${arg} requires a path`);
      }
      bundleArg = value;
      i += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return {
    entry,
    outfile,
    bundlePath: bundleArg ?? outfile,
    noBuild,
  };
}

async function runBuild(argv: string[]): Promise<void> {
  const { entry, outfile } = parseBuildArgs(argv);
  await buildAgentBundle({ entry, outfile });
  process.stdout.write(`Built ${outfile} from ${entry}\n`);
}

async function runVerify(argv: string[]): Promise<void> {
  const { entry, outfile, bundlePath, noBuild } = parseVerifyArgs(argv);
  const result = await runAgentVerify({
    entry,
    outfile,
    bundlePath,
    noBuild,
  });

  if (!result.ok) {
    process.stderr.write(
      `[@voicethere/agent verify] FAIL: ${formatVerifyFailure(result)}\n`,
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    printHelp();
    return;
  }

  if (args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    printHelp();
    return;
  }

  if (args[0] === "build") {
    await runBuild(args.slice(1));
    return;
  }

  if (args[0] === "verify") {
    await runVerify(args.slice(1));
    return;
  }

  if (args[0]?.startsWith("-")) {
    process.stderr.write(
      "Missing command. Use `build` or `verify` before options.\n\n",
    );
    printHelp();
    process.exit(1);
  }

  process.stderr.write(`Unknown command: ${args[0]}\n\n`);
  printHelp();
  process.exit(1);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[@voicethere/agent] ${message}\n`);
  process.exit(1);
});
