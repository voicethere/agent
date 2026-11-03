import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runFlowCommand, type FlowCliIo } from "../../src/flow/cli-flow.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "../../dist/cli.js");
const TEMPLATE = join(here, "../../templates/flow-agent");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flow-cli-"));
  copyFileSync(
    join(TEMPLATE, "voicethere.flow.json"),
    join(dir, "voicethere.flow.json"),
  );
  copyFileSync(
    join(TEMPLATE, "voicethere.flow.mocks.json"),
    join(dir, "voicethere.flow.mocks.json"),
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function cli(args: string[], input?: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI, "flow", ...args], {
    cwd: dir,
    encoding: "utf8",
    input,
    env: { PATH: process.env.PATH ?? "", ...env },
    timeout: 20_000,
  });
}

describe("flow validate", () => {
  it("accepts the template flow", () => {
    const r = cli(["validate"]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("is valid");
  });

  it("a broken file exits 1 and prints node, path and code", () => {
    const doc = JSON.parse(
      readFileSync(join(dir, "voicethere.flow.json"), "utf8"),
    );
    doc.nodes[0].next = "ghost";
    writeFileSync(join(dir, "bad.json"), JSON.stringify(doc));
    const r = cli(["validate", "bad.json"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("FLOW_UNKNOWN_TARGET");
    expect(r.stdout).toContain("greet");
  });

  it("a file that is not JSON exits 1", () => {
    writeFileSync(join(dir, "x.json"), "{nope");
    const r = cli(["validate", "x.json"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not valid JSON");
  });
});

describe("flow migrate", () => {
  it("reports a current file as up to date", () => {
    const r = cli(["migrate"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("already on the current version");
  });
});

describe("flow run --mock", () => {
  it("routes an invoice question to billing and writes the trace", () => {
    const r = cli(
      ["run", "--mock", "--trace", "trace.json"],
      "I have a question about my invoice\n",
    );
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const lines = r.stdout.split("\n");
    expect(lines).toContain("agent> Hi! Is this about billing or support?");
    expect(r.stdout).toContain("[topic] → billing");
    expect(r.stdout).toContain(
      "agent> Thanks. A billing specialist will follow up on your invoice by email.",
    );
    const trace = JSON.parse(readFileSync(join(dir, "trace.json"), "utf8"));
    expect(Array.isArray(trace)).toBe(true);
    expect(
      trace.some((e: any) => e.nodeId === "topic" && e.edge === "billing"),
    ).toBe(true);
    // variable values are only traced with --values
    expect(trace.every((e: any) => e.vars === undefined)).toBe(true);
  });

  it("a named mock case picks the support path", () => {
    const r = cli(["run", "--mock", "support"], "xyzzy plugh\n");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("[topic] → support");
    expect(r.stdout).toContain("agent> Try restarting the app.");
  });

  it("--values puts variable values in the trace file", () => {
    const r = cli(
      ["run", "--mock", "--values", "--trace", "t.json"],
      "billing\n",
    );
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const trace = JSON.parse(readFileSync(join(dir, "t.json"), "utf8"));
    expect(trace.some((e: any) => e.vars !== undefined)).toBe(true);
  });

  it("--step prints one numbered line per node and waits for Enter", () => {
    const r = cli(["run", "--mock", "--step"], "\n\nbilling\n\n\n\n\n\n\n\n");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/\[1\] greet \(speak\)/);
    expect(r.stdout).toMatch(/\[\d+\] ask \(listen\)/);
  });

  it("without a mocks file --mock fails", () => {
    rmSync(join(dir, "voicethere.flow.mocks.json"));
    const r = cli(["run", "--mock"], "");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("voicethere.flow.mocks.json");
  });

  it("a real run without the key fails naming the variable, never a value", () => {
    const r = cli(["run"], "", { AGENT_OTHER: "supersecret-value" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("AGENT_OPENROUTER_API_KEY");
    expect(r.stdout + r.stderr).not.toContain("supersecret-value");
  });
});

describe("flow mock generate", () => {
  it("writes generated cases for mockable nodes and keeps others", () => {
    const r = cli(["mock", "generate", "--seed", "7"]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const mocks = JSON.parse(
      readFileSync(join(dir, "voicethere.flow.mocks.json"), "utf8"),
    );
    expect(mocks.nodes.topic.map((c: any) => c.name)).toContain("generated");
    expect(mocks.nodes.topic.map((c: any) => c.name)).toContain("billing");
    expect(mocks.nodes.supportHelp[0].llm.text).toContain("supportHelp");
  });

  it("an unknown node id fails", () => {
    const r = cli(["mock", "generate", "nope"]);
    expect(r.status).toBe(1);
  });
});

describe("malformed mocks file", () => {
  const BROKEN = '{ "version": 1, ';
  const mocksPath = () => join(dir, "voicethere.flow.mocks.json");

  it("mock generate refuses to overwrite an unparsable mocks file", () => {
    writeFileSync(mocksPath(), BROKEN);
    const r = cli(["mock", "generate"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not valid JSON");
    expect(readFileSync(mocksPath(), "utf8")).toBe(BROKEN);
  });

  it("run --record refuses before any call and keeps the file", () => {
    writeFileSync(mocksPath(), BROKEN);
    const r = cli(["run", "--record"], "", {
      AGENT_OPENROUTER_API_KEY: "k",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not valid JSON");
    expect(readFileSync(mocksPath(), "utf8")).toBe(BROKEN);
  });

  it("run --mock exits 1 on it", () => {
    writeFileSync(mocksPath(), BROKEN);
    const r = cli(["run", "--mock"], "");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not valid JSON");
  });
});

describe("--mock case name", () => {
  it("--mock with an unknown case name fails", () => {
    const r = cli(["run", "--mock", "nope"], "hi\n");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no mock case named nope");
  });
});

describe("Ctrl-C", () => {
  it("the interrupt handler writes the trace collected so far", async () => {
    let interrupt: (() => void) | undefined;
    let release!: (l: string | null) => void;
    const out: string[] = [];
    const io: FlowCliIo = {
      out: (t) => void out.push(t),
      err: () => {},
      env: {},
      cwd: dir,
      onInterrupt: (h) => (interrupt = h),
      readLine: () => new Promise((r) => (release = r)),
    };
    const done = runFlowCommand(
      ["run", "--mock", "--trace", "partial.json"],
      io,
    );
    await vi.waitFor(() => expect(interrupt).toBeDefined());
    await vi.waitFor(() => expect(out.join("")).toContain("you> "));
    interrupt!();
    const trace = JSON.parse(readFileSync(join(dir, "partial.json"), "utf8"));
    expect(trace.some((e: any) => e.nodeId === "greet")).toBe(true);
    release(null);
    expect(await done).toBe(0);
  });

  it("--step does not register an interrupt handler", async () => {
    let registered = false;
    const lines = ["", "", "billing", "", "", "", "", "", ""];
    const io: FlowCliIo = {
      out: () => {},
      err: () => {},
      env: {},
      cwd: dir,
      onInterrupt: () => (registered = true),
      readLineSync: () => lines.shift() ?? null,
    };
    expect(await runFlowCommand(["run", "--mock", "--step"], io)).toBe(0);
    expect(registered).toBe(false);
  });
});
