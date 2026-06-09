#!/usr/bin/env node
/**
 * Customer-facing CLI — bundle agent source for the VoiceThere sandbox.
 *
 *   npx @voicethere/agent build
 *   npx @voicethere/agent build --entry agent.ts --outfile dist/agent.js
 */

import { buildAgentBundle } from "./build-bundle.js";

const DEFAULT_ENTRY = "agent.ts";
const DEFAULT_OUTFILE = "dist/agent.js";

function printHelp(): void {
  process.stdout.write(`@voicethere/agent — bundle your voice agent for VoiceThere

Usage:
  npx @voicethere/agent build [options]
  npx @voicethere/agent [options]          (build is the default command)

Options:
  --entry, -e <path>     Agent entry file (default: ${DEFAULT_ENTRY})
  --outfile, -o <path>   Output bundle (default: ${DEFAULT_OUTFILE})
  --help, -h             Show this help

Example:
  npm install @voicethere/agent
  npx @voicethere/agent build --entry src/agent.ts --outfile dist/agent.js
`);
}

interface BuildCliOptions {
  entry: string;
  outfile: string;
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

async function runBuild(argv: string[]): Promise<void> {
  const { entry, outfile } = parseBuildArgs(argv);
  await buildAgentBundle({ entry, outfile });
  process.stdout.write(`Built ${outfile} from ${entry}\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    await runBuild([]);
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

  if (args[0]?.startsWith("-")) {
    await runBuild(args);
    return;
  }

  process.stderr.write(`Unknown command: ${args[0]}\n\n`);
  printHelp();
  process.exit(1);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`agent build failed: ${message}\n`);
  process.exit(1);
});
