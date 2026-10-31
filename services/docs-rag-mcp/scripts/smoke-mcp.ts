// Smoke test and latency probe for a running docs-rag-mcp server.
//   node scripts/smoke-mcp.ts --url http://127.0.0.1:8080/mcp \
//     --query "how much does the team plan cost" --expect-doc pricing.md [--searches 50]
// Lists the tools, calls both, checks the answer, and prints p50/p95 of N searches.
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://127.0.0.1:8080/mcp" },
    query: { type: "string", default: "pricing" },
    "expect-doc": { type: "string" },
    prefix: { type: "string", default: "" },
    searches: { type: "string", default: "1" },
    token: { type: "string" },
  },
});

function fail(message: string): never {
  console.error(`smoke failed: ${message}`);
  process.exit(1);
}

type Content = {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
};
const textOf = (r: unknown): string =>
  ((r as Content).content ?? []).map((c) => c.text ?? "").join("\n");

const search = `${values.prefix}search_docs`;
const doc = `${values.prefix}get_doc`;
const client = new Client({ name: "docs-rag-smoke", version: "1.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(values.url!), {
    requestInit: values.token
      ? { headers: { Authorization: `Bearer ${values.token}` } }
      : undefined,
  }),
);

const names = (await client.listTools()).tools.map((t) => t.name).sort();
for (const n of [search, doc]) {
  if (!names.includes(n)) fail(`tool ${n} missing, got ${names.join(", ")}`);
}

const first = await client.callTool({
  name: search,
  arguments: { query: values.query!, k: 3 },
});
const firstText = textOf(first);
if ((first as Content).isError || firstText.length === 0)
  fail("search returned an error");
if (firstText.length > 4000) fail(`search text is ${firstText.length} chars`);
const ids = [...firstText.matchAll(/\(id: ([^)\n]+)\)/g)].map((m) => m[1]!);
if (ids.length === 0) fail("search returned no hit ids");
if (values["expect-doc"] && !ids.includes(values["expect-doc"])) {
  fail(`expected ${values["expect-doc"]} among ${ids.join(", ")}`);
}

const got = await client.callTool({ name: doc, arguments: { id: ids[0]! } });
const gotText = textOf(got);
if ((got as Content).isError || gotText.length < 20 || gotText.length > 12000) {
  fail(`get_doc returned ${gotText.length} chars`);
}
const missing = textOf(
  await client.callTool({ name: doc, arguments: { id: "no-such-page" } }),
);
if (missing !== "not found") fail("get_doc did not answer not found");

const n = Math.max(1, Number(values.searches));
const times: number[] = [];
for (let i = 0; i < n; i++) {
  const t0 = performance.now();
  const r = await client.callTool({
    name: search,
    arguments: { query: `${values.query} ${i}`, k: 5 },
  });
  times.push(performance.now() - t0);
  if ((r as Content).isError) fail(`search ${i} failed`);
}
times.sort((a, b) => a - b);
const pct = (p: number) =>
  times[Math.min(times.length - 1, Math.floor(p * times.length))]!;
console.log(
  JSON.stringify({
    ok: true,
    tools: names,
    topIds: ids,
    searches: n,
    p50Ms: Math.round(pct(0.5)),
    p95Ms: Math.round(pct(0.95)),
  }),
);
await client.close();
