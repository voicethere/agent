import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createSupabaseKnowledgeBase,
  type LlmEmbedder,
} from "../../src/llm/index.js";

/**
 * Real runtime for the Supabase path: Postgres with pgvector plus PostgREST
 * (the REST layer Supabase uses), with the table and `match_documents`
 * function from the Supabase semantic-search guide
 * (https://supabase.com/docs/guides/ai/semantic-search), vector size 64.
 * Skipped with a named reason when docker is unavailable.
 * AGENT_TEST_POSTGREST_IMAGE overrides the PostgREST image.
 */
const PG_IMAGE = "pgvector/pgvector:pg17";
const REST_IMAGE =
  process.env.AGENT_TEST_POSTGREST_IMAGE ?? "postgrest/postgrest:v12.2.12";
const DIMS = 64;
const JWT_SECRET = "agent-kb-test-secret-at-least-32-chars-long";
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ role: "anon" })}`;
const ANON_JWT = `${head}.${createHmac("sha256", JWT_SECRET).update(head).digest("base64url")}`;
const tag = `agent-kb-${process.pid}`;
const net = `${tag}-net`;
const pgName = `${tag}-pg`;
const restName = `${tag}-rest`;

function docker(args: string[], input?: string) {
  return spawnSync("docker", args, { encoding: "utf8", input });
}

const dockerUp = docker(["info"]).status === 0;
const skipReason = dockerUp ? "" : "docker is not available";

function embed(text: string, dims = DIMS): number[] {
  const v = new Array<number>(dims).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    v[createHash("sha1").update(word).digest().readUInt32BE(0) % dims]! += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

const fakeEmbedder: LlmEmbedder = {
  id: "openai",
  async embed(req) {
    return {
      vectors: req.inputs.map((t) => embed(t, req.dimensions ?? DIMS)),
      model: "fake",
      dims: req.dimensions ?? DIMS,
    };
  },
};

const ROWS = [
  "The starter plan costs ten dollars a month and includes ten minutes.",
  "Choose a text to speech voice for your agent in the dashboard.",
  "Deploy publishes the agent bundle to production.",
];

const SQL = `
create extension if not exists vector;
create table documents (id bigserial primary key, content text, embedding vector(${DIMS}));
create or replace function match_documents (
  query_embedding vector(${DIMS}),
  match_threshold float,
  match_count int
)
returns table (id bigint, content text, similarity float)
language sql stable
as $$
  select documents.id, documents.content, 1 - (documents.embedding <=> query_embedding) as similarity
  from documents
  where 1 - (documents.embedding <=> query_embedding) > match_threshold
  order by (documents.embedding <=> query_embedding) asc
  limit match_count;
$$;
create role anon nologin;
grant usage on schema public to anon;
grant select on documents to anon;
grant execute on function match_documents(vector, float, int) to anon;
${ROWS.map((r) => `insert into documents (content, embedding) values ('${r}', '[${embed(r).join(",")}]');`).join("\n")}
`;

let restUrl = "";
let gateway: Server | undefined;

/** Supabase's gateway serves PostgREST under /rest/v1; standalone PostgREST has no prefix. */
async function startGateway(target: string): Promise<string> {
  const t = new URL(target);
  gateway = createServer((req, res) => {
    const path = (req.url ?? "/").replace(/^\/rest\/v1/, "") || "/";
    const up = httpRequest(
      {
        host: t.hostname,
        port: t.port,
        path,
        method: req.method,
        headers: req.headers,
      },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    up.on("error", () => res.writeHead(502).end());
    req.pipe(up);
  });
  await new Promise<void>((r) => gateway!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
}

async function waitFor(ok: () => Promise<boolean>, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("docker service did not become ready");
}

describe.skipIf(!dockerUp)(
  `supabase pgvector (real runtime) ${skipReason}`,
  () => {
    beforeAll(async () => {
      docker(["network", "create", net]);
      const pg = docker([
        "run",
        "-d",
        "--rm",
        "--name",
        pgName,
        "--network",
        net,
        "-e",
        "POSTGRES_PASSWORD=pw",
        PG_IMAGE,
      ]);
      if (pg.status !== 0)
        throw new Error(`postgres start failed: ${pg.stderr}`);
      await waitFor(async () => {
        const r = docker(["exec", pgName, "pg_isready", "-U", "postgres"]);
        if (r.status !== 0) return false;
        // The image restarts once after init; wait until a query works twice.
        const q = docker([
          "exec",
          pgName,
          "psql",
          "-U",
          "postgres",
          "-tAc",
          "select 1",
        ]);
        return q.status === 0;
      }, 60_000);
      await new Promise((r) => setTimeout(r, 1500));
      const sql = docker(
        [
          "exec",
          "-i",
          pgName,
          "psql",
          "-U",
          "postgres",
          "-v",
          "ON_ERROR_STOP=1",
        ],
        SQL,
      );
      if (sql.status !== 0) throw new Error(`sql failed: ${sql.stderr}`);
      const rest = docker([
        "run",
        "-d",
        "--rm",
        "--name",
        restName,
        "--network",
        net,
        "-p",
        "127.0.0.1::3000",
        "-e",
        `PGRST_DB_URI=postgres://postgres:pw@${pgName}:5432/postgres`,
        "-e",
        "PGRST_DB_SCHEMAS=public",
        "-e",
        "PGRST_DB_ANON_ROLE=anon",
        "-e",
        `PGRST_JWT_SECRET=${JWT_SECRET}`,
        REST_IMAGE,
      ]);
      if (rest.status !== 0)
        throw new Error(`postgrest start failed: ${rest.stderr}`);
      const port = docker(["port", restName, "3000/tcp"])
        .stdout.trim()
        .split(":")
        .pop();
      const direct = `http://127.0.0.1:${port}`;
      await waitFor(
        async () => (await fetch(`${direct}/`)).status < 500,
        60_000,
      );
      restUrl = await startGateway(direct);
    }, 180_000);

    afterAll(() => {
      gateway?.close();
      docker(["rm", "-f", restName]);
      docker(["rm", "-f", pgName]);
      docker(["network", "rm", net]);
    });

    it("returns the row that answers the query through match_documents", async () => {
      const kb = createSupabaseKnowledgeBase({
        url: restUrl,
        key: ANON_JWT,
        embedder: fakeEmbedder,
        model: "fake",
        dims: DIMS,
        matchThreshold: 0.1,
        allowInsecureLocal: true,
      });
      const hits = await kb.search("how much does the starter plan cost", 3);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.text).toBe(ROWS[0]);
      expect(hits[0]!.source).toBe("supabase");
      expect(hits[0]!.score).toBeGreaterThan(hits.at(-1)!.score - 1e-9);
    });
  },
);
