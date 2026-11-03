/**
 * `npx @voicethere/agent flow <validate|migrate|mock|run>`.
 *
 * Output goes to the developer's own terminal, so it may show their own
 * transcript and (with --values) variable values. It never prints environment
 * secret values, and recorded mocks are redacted by `wrapRecording`.
 */
import { existsSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { buildToolRegistry } from "../llm/agent/build-tool-registry.js";
import { LLM_AGENT_CONFIG_DEFAULTS } from "../llm/agent/config.js";
import { createLlmProvider } from "../llm/providers.js";
import type { ToolRegistry } from "../llm/mcp/tool-registry.js";
import type { LlmProvider, LlmProviderModule } from "../llm/types.js";
import { compileFlow } from "./core/compile.js";
import type { FlowEffects } from "./core/effects.js";
import { FlowSession } from "./core/interpreter.js";
import { migrateFlow } from "./core/migrate.js";
import { generateMock } from "./core/generate-mock.js";
import { createMockEffects } from "./core/mock-effects.js";
import { validateMocks } from "./core/mocks.js";
import type { FlowMockCase, FlowMocks } from "./core/mocks.js";
import type { FlowTraceEvent } from "./core/trace.js";
import type { FlowDocument, FlowIssue, FlowModel } from "./core/types.js";
import { validateFlow } from "./core/validate.js";
import { createNodeEffects } from "./effects-node.js";
import { createMockRecorder, wrapRecording } from "./record.js";

export const DEFAULT_FLOW_FILE = "voicethere.flow.json";
export const DEFAULT_MOCKS_FILE = "voicethere.flow.mocks.json";

export interface FlowCliIo {
  out(text: string): void;
  err(text: string): void;
  /** Async line input (the REPL). Resolves null at end of input. */
  readLine?: () => Promise<string | null>;
  /** Blocking line input for `--step`. */
  readLineSync?: () => string | null;
  env: Record<string, string | undefined>;
  cwd: string;
}

const FLOW_USAGE = `Usage:
  npx @voicethere/agent flow validate [file]
  npx @voicethere/agent flow migrate [file] [--write]
  npx @voicethere/agent flow mock generate [nodeId] [--seed N] [--flow file] [--file mocks.json]
  npx @voicethere/agent flow run [file] [--env file] [--mock [case]] [--record]
                                 [--trace out.json] [--step] [--values]
`;

function issueLine(i: FlowIssue): string {
  return `${i.nodeId ?? "-"} ${i.path === "" ? "/" : i.path} ${i.code} ${i.message}`;
}

function readJson(
  file: string,
  io: FlowCliIo,
): { ok: true; value: unknown } | { ok: false } {
  const path = resolve(io.cwd, file);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    io.err(`cannot read ${file}\n`);
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    io.err(`${file} is not valid JSON\n`);
    return { ok: false };
  }
}

function loadFlow(
  file: string,
  io: FlowCliIo,
): { flow: FlowDocument; warnings: FlowIssue[] } | undefined {
  const raw = readJson(file, io);
  if (!raw.ok) return undefined;
  const migrated = migrateFlow(raw.value);
  const v = validateFlow(migrated.doc);
  for (const w of v.warnings) io.out(`warning ${issueLine(w)}\n`);
  if (!v.ok || !v.flow) {
    for (const e of v.errors) io.out(`${issueLine(e)}\n`);
    return undefined;
  }
  return { flow: v.flow, warnings: v.warnings };
}

interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
}

/** `valueFlags` take a value; `optionalValue` flags take one unless the next token is a flag or a .json file. */
function parseArgs(
  argv: string[],
  valueFlags: string[],
  boolFlags: string[],
  optionalValue: string[] = [],
): Parsed | string {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    if (valueFlags.includes(a)) {
      const v = argv[i + 1];
      if (v === undefined) return `${a} requires a value`;
      flags.set(a, v);
      i += 1;
    } else if (optionalValue.includes(a)) {
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith("--") && !v.endsWith(".json")) {
        flags.set(a, v);
        i += 1;
      } else flags.set(a, true);
    } else if (boolFlags.includes(a)) flags.set(a, true);
    else return `Unknown option: ${a}`;
  }
  return { positional, flags };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readMocksFile(path: string): FlowMocks {
  if (!existsSync(path)) return { version: 1, nodes: {} };
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as FlowMocks;
    if (v && typeof v === "object" && v.nodes) return v;
  } catch {
    // fall through
  }
  return { version: 1, nodes: {} };
}

function validate(argv: string[], io: FlowCliIo): number {
  const p = parseArgs(argv, [], []);
  if (typeof p === "string") return fail(io, p);
  const file = p.positional[0] ?? DEFAULT_FLOW_FILE;
  const raw = readJson(file, io);
  if (!raw.ok) return 1;
  const v = validateFlow(migrateFlow(raw.value).doc);
  for (const w of v.warnings) io.out(`warning ${issueLine(w)}\n`);
  for (const e of v.errors) io.out(`${issueLine(e)}\n`);
  if (!v.ok) return 1;
  io.out(`${file} is valid\n`);
  return 0;
}

function migrate(argv: string[], io: FlowCliIo): number {
  const p = parseArgs(argv, [], ["--write"]);
  if (typeof p === "string") return fail(io, p);
  const file = p.positional[0] ?? DEFAULT_FLOW_FILE;
  const raw = readJson(file, io);
  if (!raw.ok) return 1;
  const m = migrateFlow(raw.value);
  if (!m.migrated) {
    io.out(`${file} is already on the current version\n`);
    return 0;
  }
  if (p.flags.has("--write")) {
    writeJson(resolve(io.cwd, file), m.doc);
    io.out(`${file} migrated\n`);
  } else io.out(`${JSON.stringify(m.doc, null, 2)}\n`);
  return 0;
}

function mockGenerate(argv: string[], io: FlowCliIo): number {
  const p = parseArgs(argv, ["--seed", "--flow", "--file"], []);
  if (typeof p === "string") return fail(io, p);
  const flowFile =
    (p.flags.get("--flow") as string | undefined) ?? DEFAULT_FLOW_FILE;
  const mocksFile =
    (p.flags.get("--file") as string | undefined) ?? DEFAULT_MOCKS_FILE;
  const seedArg = p.flags.get("--seed") as string | undefined;
  const seed = seedArg === undefined ? 1 : Number(seedArg);
  if (!Number.isInteger(seed)) return fail(io, "--seed must be an integer");
  const loaded = loadFlow(flowFile, io);
  if (!loaded) return 1;
  const { flow } = loaded;
  const wanted = p.positional[0];
  const nodes = flow.nodes.filter((n) =>
    wanted !== undefined
      ? n.id === wanted
      : ["http", "mcp", "llm", "route"].includes(n.type),
  );
  if (wanted !== undefined && nodes.length === 0)
    return fail(io, `no node with id ${wanted}`);
  const path = resolve(io.cwd, mocksFile);
  const mocks = readMocksFile(path);
  let count = 0;
  for (const node of nodes) {
    if (!["http", "mcp", "llm", "route"].includes(node.type)) {
      if (wanted !== undefined)
        return fail(io, `node ${wanted} (${node.type}) has no mock data`);
      continue;
    }
    const c = generateMock(node, { flow, seed });
    const rest = (mocks.nodes[node.id] ?? []).filter((x) => x.name !== c.name);
    mocks.nodes[node.id] = [c, ...rest];
    count += 1;
  }
  const check = validateMocks(mocks, flow);
  if (!check.ok) {
    for (const e of check.errors)
      io.out(`${e.nodeId ?? "-"} ${e.path} ${e.code} ${e.message}\n`);
    return 1;
  }
  writeJson(path, mocks);
  io.out(`wrote ${count} generated case(s) to ${mocksFile}\n`);
  return 0;
}

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    let key = t.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice(7).trim();
    let value = t.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      (value[0] === '"' || value[0] === "'") &&
      value.endsWith(value[0]!)
    )
      value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

async function providerModulesFor(
  flow: FlowDocument,
): Promise<LlmProviderModule[]> {
  const ids = new Set<string>();
  for (const m of Object.values(flow.models))
    if ("provider" in m) ids.add(m.provider);
  const mods: LlmProviderModule[] = [];
  if (ids.has("openai") || ids.has("openrouter"))
    mods.push((await import("../llm/openai.js")).openai);
  if (ids.has("anthropic"))
    mods.push((await import("../llm/anthropic.js")).anthropic);
  if (ids.has("gemini")) mods.push((await import("../llm/gemini.js")).gemini);
  return mods;
}

async function run(argv: string[], io: FlowCliIo): Promise<number> {
  const p = parseArgs(
    argv,
    ["--env", "--trace"],
    ["--record", "--step", "--values"],
    ["--mock"],
  );
  if (typeof p === "string") return fail(io, p);
  const file = p.positional[0] ?? DEFAULT_FLOW_FILE;
  const mockFlag = p.flags.get("--mock");
  const record = p.flags.has("--record");
  const step = p.flags.has("--step");
  const values = p.flags.has("--values");
  const tracePath = p.flags.get("--trace") as string | undefined;
  if (record && mockFlag !== undefined)
    return fail(
      io,
      "--record makes real calls and cannot be combined with --mock",
    );

  const loaded = loadFlow(file, io);
  if (!loaded) return 1;
  const { flow } = loaded;
  const compiled = compileFlow(flow);
  const mocksPath = join(dirname(resolve(io.cwd, file)), DEFAULT_MOCKS_FILE);

  let env = { ...io.env };
  const envFile = p.flags.get("--env") as string | undefined;
  if (envFile !== undefined) {
    try {
      env = {
        ...env,
        ...parseEnvFile(readFileSync(resolve(io.cwd, envFile), "utf8")),
      };
    } catch {
      return fail(io, `cannot read ${envFile}`);
    }
  }

  const events: FlowTraceEvent[] = [];
  const step0 = (e: FlowTraceEvent): void => {
    events.push(e);
    if (e.phase === "enter") {
      if (step) {
        io.out(`[${e.seq}] ${e.nodeId} (${e.type})\n`);
        io.readLineSync?.();
      }
    } else if (e.error !== undefined)
      io.out(`[${e.nodeId}] error ${e.error}\n`);
    else if (e.edge !== undefined) io.out(`[${e.nodeId}] → ${e.edge}\n`);
  };
  const clock = {
    now: () => Date.now(),
    setTimeout(fn: () => void, ms: number) {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    },
  };
  const base = {
    speak(text: string) {
      io.out(`agent> ${text}\n`);
      return {
        done: Promise.resolve({ status: "completed" }),
        cancel() {},
      };
    },
    chat(text: string) {
      io.out(`agent> ${text}\n`);
    },
    end(reason: string) {
      io.out(`[end] ${reason}\n`);
    },
    log(
      level: "info" | "warn",
      message: string,
      fields: Record<string, unknown>,
    ) {
      if (level === "warn")
        io.err(`[warn] ${message} ${JSON.stringify(fields)}\n`);
    },
    trace: step0,
    clock,
  };

  let effects: FlowEffects;
  let registry: ToolRegistry | undefined;
  const recorder = createMockRecorder();
  if (mockFlag !== undefined) {
    if (!existsSync(mocksPath))
      return fail(io, `--mock needs ${DEFAULT_MOCKS_FILE} next to the flow`);
    const mv = validateMocks(readMocksFile(mocksPath), flow);
    if (!mv.ok || !mv.mocks) {
      for (const e of mv.errors)
        io.out(`${e.nodeId ?? "-"} ${e.path} ${e.code} ${e.message}\n`);
      return 1;
    }
    const wanted = typeof mockFlag === "string" ? mockFlag : undefined;
    effects = createMockEffects(base, mv.mocks, {
      pick: (_id, cases: FlowMockCase[]) =>
        (wanted !== undefined
          ? cases.find((c) => c.name === wanted)
          : undefined) ?? cases[0],
    });
  } else {
    let modules: LlmProviderModule[];
    try {
      modules = await providerModulesFor(flow);
    } catch {
      return fail(
        io,
        "cannot load the provider SDK; install the package for your provider",
      );
    }
    for (const m of Object.values(compiled.models)) {
      const v = env[m.apiKeySecret];
      if (v === undefined || v === "")
        return fail(io, `environment variable ${m.apiKeySecret} is not set`);
    }
    const cache = new Map<string, LlmProvider>();
    const providerFor = (model: FlowModel): LlmProvider => {
      const key = `${model.provider}\u0000${model.baseUrl ?? ""}\u0000${model.apiKeySecret}`;
      const hit = cache.get(key);
      if (hit) return hit;
      const created = createLlmProvider(
        {
          provider: model.provider,
          apiKey: env[model.apiKeySecret] ?? "",
          ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
        },
        modules,
      );
      cache.set(key, created);
      return created;
    };
    const toolSources = flow.tools?.toolSources ?? [];
    if (toolSources.length > 0) {
      const D = LLM_AGENT_CONFIG_DEFAULTS;
      registry = buildToolRegistry({
        env,
        toolSources,
        customTools: [],
        secretNames: Object.values(compiled.models).map((m) => m.apiKeySecret),
        toolCallLogs: D.toolCallLogs,
        servicePath: D.servicePath,
      }).registry;
    }
    const node = createNodeEffects({
      sessionId: "local",
      env,
      providerFor,
      registry,
      log: (level, message, fields) => base.log(level, message, fields),
    });
    effects = { ...node, ...base };
    if (record)
      effects = wrapRecording(effects, recorder.sink, {
        env,
        referencedSecrets: [
          ...(flow.secrets ?? []),
          ...Object.values(compiled.models).map((m) => m.apiKeySecret),
        ],
      });
  }

  const session = new FlowSession(compiled, effects, {
    sessionId: "local",
    channel: "chat",
    includeValuesInTrace: values,
  });
  await session.start();
  while (!session.ended) {
    io.out("you> ");
    const line = step ? (io.readLineSync?.() ?? null) : await io.readLine?.();
    if (line === null || line === undefined) break;
    const text = line.trim();
    if (text === "") continue;
    await session.onUserText(text, { source: "chat" });
  }
  io.out("\n");
  session.stop();

  if (tracePath !== undefined) writeJson(resolve(io.cwd, tracePath), events);
  if (record) {
    const existing = readMocksFile(mocksPath);
    const fresh = recorder.mocks();
    for (const [id, cases] of Object.entries(fresh.nodes)) {
      const kept = (existing.nodes[id] ?? []).filter(
        (c) => !c.name.startsWith("recorded-"),
      );
      existing.nodes[id] = [...kept, ...cases];
    }
    writeJson(mocksPath, existing);
    io.out(`recorded cases saved to ${DEFAULT_MOCKS_FILE}\n`);
  }
  return 0;
}

function fail(io: FlowCliIo, message: string): number {
  io.err(`${message}\n\n${FLOW_USAGE}`);
  return 1;
}

/** Runs `flow <args>`; resolves to the process exit code. */
export async function runFlowCommand(
  args: string[],
  io: FlowCliIo,
): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "validate":
      return validate(rest, io);
    case "migrate":
      return migrate(rest, io);
    case "mock":
      if (rest[0] === "generate") return mockGenerate(rest.slice(1), io);
      return fail(io, "Unknown flow mock command");
    case "run":
      return run(rest, io);
    case undefined:
    case "--help":
    case "-h":
      io.out(FLOW_USAGE);
      return 0;
    default:
      return fail(io, `Unknown flow command: ${sub}`);
  }
}

/** Process-backed IO for the CLI entry point. */
export function processFlowIo(): FlowCliIo {
  let rl: ReturnType<typeof createInterface> | undefined;
  const queue: string[] = [];
  let closed = false;
  let waiter: ((l: string | null) => void) | undefined;
  const ensure = (): void => {
    if (rl) return;
    rl = createInterface({ input: process.stdin });
    rl.on("line", (l) => {
      if (waiter) {
        const w = waiter;
        waiter = undefined;
        w(l);
      } else queue.push(l);
    });
    rl.on("close", () => {
      closed = true;
      if (waiter) {
        const w = waiter;
        waiter = undefined;
        w(null);
      }
    });
  };
  let syncBuf = "";
  let syncEof = false;
  return {
    out: (t) => void process.stdout.write(t),
    err: (t) => void process.stderr.write(t),
    env: process.env,
    cwd: process.cwd(),
    readLine() {
      ensure();
      const q = queue.shift();
      if (q !== undefined) return Promise.resolve(q);
      if (closed) return Promise.resolve(null);
      return new Promise((r) => (waiter = r));
    },
    readLineSync() {
      const chunk = Buffer.alloc(1);
      for (;;) {
        const nl = syncBuf.indexOf("\n");
        if (nl >= 0) {
          const line = syncBuf.slice(0, nl).replace(/\r$/, "");
          syncBuf = syncBuf.slice(nl + 1);
          return line;
        }
        if (syncEof) {
          if (syncBuf === "") return null;
          const rest = syncBuf;
          syncBuf = "";
          return rest;
        }
        let n = 0;
        try {
          n = readSync(0, chunk, 0, 1, null);
        } catch (err) {
          if ((err as { code?: string }).code === "EAGAIN") {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
            continue;
          }
          n = 0;
        }
        if (n === 0) syncEof = true;
        else syncBuf += chunk.toString("utf8", 0, n);
      }
    },
  };
}
