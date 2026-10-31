import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";

const here = resolve(import.meta.dirname, "..");
const dockerfile = readFileSync(join(here, "Dockerfile"), "utf8");
const customer = readFileSync(
  join(here, "examples", "Dockerfile.customer"),
  "utf8",
);

describe("base image Dockerfile", () => {
  it("checks the model files, native binaries and docs-rag on PATH at build time", () => {
    for (const f of [
      "config.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "onnx/model_quantized.onnx",
    ]) {
      expect(dockerfile).toContain(f);
    }
    expect(dockerfile).toContain(
      'test -f "/model/Xenova/bge-small-en-v1.5/$f"',
    );
    expect(dockerfile).toContain("onnxruntime_binding.node");
    expect(dockerfile).toContain("prebuilds/linux-${arch}.node");
    expect(dockerfile).toContain("vec_version()");
    expect(dockerfile).toContain("/usr/local/bin/docs-rag");
  });
  it("runs the onnxruntime-node install script, as non-root, with INDEX_DIR=/index on port 8080", () => {
    expect(dockerfile).toContain("npm rebuild onnxruntime-node");
    expect(dockerfile).toContain("USER node");
    expect(dockerfile).toContain("INDEX_DIR=/index");
    expect(dockerfile).toContain("EXPOSE 8080");
    expect(dockerfile).toContain('CMD ["node", "src/server.ts"]');
  });
});

describe("customer example", () => {
  it("extends the base, copies docs and builds the index", () => {
    expect(customer).toMatch(/^FROM \$\{BASE\}$/m);
    expect(customer).toContain("COPY docs/ /docs/");
    expect(customer).toContain("docs-rag build --docs /docs");
    expect(customer).toContain("--out /index");
  });
});

// Needs Docker and a built base image: DOCS_RAG_BASE_IMAGE=<tag> npm test
const base = process.env.DOCS_RAG_BASE_IMAGE;
describe.skipIf(!base)("customer image built from the base (docker)", () => {
  it("builds from the sample docs, starts, becomes healthy and answers", async () => {
    const ctx = mkdtempSync(join(tmpdir(), "rag-img-"));
    cpSync(join(here, "fixtures", "docs"), join(ctx, "docs"), {
      recursive: true,
    });
    const tag = `docs-rag-customer-test:${process.pid}`;
    let container = "";
    try {
      execFileSync(
        "docker",
        [
          "build",
          "-f",
          join(here, "examples", "Dockerfile.customer"),
          "--build-arg",
          `BASE=${base}`,
          "-t",
          tag,
          ctx,
        ],
        { stdio: "pipe" },
      );
      container = execFileSync("docker", [
        "run",
        "-d",
        "--rm",
        "-p",
        "127.0.0.1::8080",
        tag,
      ])
        .toString()
        .trim();
      const mapped = execFileSync("docker", ["port", container, "8080/tcp"])
        .toString()
        .trim();
      const port = mapped.split("\n")[0]!.split(":").pop()!;
      const url = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 60_000;
      let healthy = false;
      while (Date.now() < deadline && !healthy) {
        healthy = await fetch(`${url}/healthz`).then(
          (r) => r.ok,
          () => false,
        );
        if (!healthy) await new Promise((r) => setTimeout(r, 500));
      }
      expect(healthy).toBe(true);
      const c = new Client({ name: "t", version: "1" });
      await c.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
      const r = (await c.callTool({
        name: "search_docs",
        arguments: { query: "How much is the Starter plan per month?" },
      })) as { content: Array<{ text: string }> };
      expect(r.content[0]!.text).toContain("pricing.md");
      await c.close();
    } finally {
      if (container) spawnSync("docker", ["rm", "-f", container]);
      spawnSync("docker", ["rmi", "-f", tag]);
      rmSync(ctx, { recursive: true, force: true });
    }
  }, 300_000);
});
