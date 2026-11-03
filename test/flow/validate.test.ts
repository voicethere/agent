import { describe, expect, it } from "vitest";
import { validateFlow } from "../../src/flow/core/index.js";
import { baseFlow } from "./fixtures.js";

const node = (f: any, id: string): any => f.nodes.find((n: any) => n.id === id);

type Case = {
  code: string;
  mutate: (f: any) => void;
  nodeId?: string;
  path: string;
  ctx?: Parameters<typeof validateFlow>[1];
};

const cases: Record<string, Case> = {
  FLOW_VERSION_UNSUPPORTED_missing: {
    code: "FLOW_VERSION_UNSUPPORTED",
    mutate: (f) => delete f.version,
    path: "/version",
  },
  FLOW_VERSION_UNSUPPORTED_newer: {
    code: "FLOW_VERSION_UNSUPPORTED",
    mutate: (f) => (f.version = 2),
    path: "/version",
  },
  FLOW_SCHEMA_unknown_key: {
    code: "FLOW_SCHEMA",
    mutate: (f) => (node(f, "greet").bogus = 1),
    nodeId: "greet",
    path: "/nodes/0/bogus",
  },
  FLOW_SCHEMA_type: {
    code: "FLOW_SCHEMA",
    mutate: (f) => (node(f, "greet").text = 5),
    nodeId: "greet",
    path: "/nodes/0/text",
  },
  FLOW_SCHEMA_limit: {
    code: "FLOW_SCHEMA",
    mutate: (f) => (node(f, "greet").text = "x".repeat(4001)),
    nodeId: "greet",
    path: "/nodes/0/text",
  },
  FLOW_SCHEMA_bad_id: {
    code: "FLOW_SCHEMA",
    mutate: (f) => (node(f, "greet").id = "1bad"),
    nodeId: "1bad",
    path: "/nodes/0/id",
  },
  FLOW_SCHEMA_unknown_type: {
    code: "FLOW_SCHEMA",
    mutate: (f) => (node(f, "greet").type = "teleport"),
    nodeId: "greet",
    path: "/nodes/0/type",
  },
  FLOW_SCHEMA_example_too_long: {
    code: "FLOW_SCHEMA",
    mutate: (f) => (node(f, "topic").paths[0].examples[0] = "x".repeat(201)),
    nodeId: "topic",
    path: "/nodes/3/paths/0/examples/0",
  },
  FLOW_SCHEMA_too_many_paths: {
    code: "FLOW_SCHEMA",
    mutate: (f) => {
      node(f, "topic").paths = Array.from({ length: 21 }, (_, i) => ({
        id: `p${i}`,
        examples: ["a"],
        next: "end",
      }));
    },
    nodeId: "topic",
    path: "/nodes/3/paths",
  },
  FLOW_SCHEMA_too_many_nodes: {
    code: "FLOW_SCHEMA",
    mutate: (f) => {
      for (let i = 0; i < 500; i++)
        f.nodes.push({ id: `n${i}`, type: "end", reason: "x" });
    },
    path: "/nodes",
  },
  FLOW_SCHEMA_http_timeout_cap: {
    code: "FLOW_SCHEMA",
    mutate: (f) => (node(f, "lookup").timeoutMs = 15001),
    nodeId: "lookup",
    path: "/nodes/4/timeoutMs",
  },
  FLOW_START_MISSING: {
    code: "FLOW_START_MISSING",
    mutate: (f) => (f.start = "nope"),
    path: "/start",
  },
  FLOW_DUPLICATE_ID: {
    code: "FLOW_DUPLICATE_ID",
    mutate: (f) => f.nodes.push({ id: "end", type: "end", reason: "again" }),
    nodeId: "end",
    path: "/nodes/9/id",
  },
  FLOW_UNKNOWN_TARGET_next: {
    code: "FLOW_UNKNOWN_TARGET",
    mutate: (f) => (node(f, "greet").next = "ghost"),
    nodeId: "greet",
    path: "/nodes/0/next",
  },
  FLOW_UNKNOWN_TARGET_path: {
    code: "FLOW_UNKNOWN_TARGET",
    mutate: (f) => (node(f, "topic").paths[1].next = "ghost"),
    nodeId: "topic",
    path: "/nodes/3/paths/1/next",
  },
  FLOW_UNKNOWN_TARGET_onError: {
    code: "FLOW_UNKNOWN_TARGET",
    mutate: (f) => (node(f, "lookup").onError = "ghost"),
    nodeId: "lookup",
    path: "/nodes/4/onError",
  },
  FLOW_UNREACHABLE: {
    code: "FLOW_UNREACHABLE",
    mutate: (f) => f.nodes.push({ id: "orphan", type: "end", reason: "x" }),
    nodeId: "orphan",
    path: "/nodes/9",
  },
  FLOW_BUSY_LOOP: {
    code: "FLOW_BUSY_LOOP",
    mutate: (f) => {
      f.nodes.push(
        { id: "a", type: "set", assign: { x: 1 }, next: "b" },
        { id: "b", type: "set", assign: { y: 1 }, next: "a" },
      );
      node(f, "greet").next = "a";
    },
    nodeId: "a",
    path: "/nodes/9",
  },
  FLOW_ROUTE_NO_PATHS: {
    code: "FLOW_ROUTE_NO_PATHS",
    mutate: (f) => (node(f, "topic").paths = []),
    nodeId: "topic",
    path: "/nodes/3/paths",
  },
  FLOW_ROUTE_NO_EXAMPLES: {
    code: "FLOW_ROUTE_NO_EXAMPLES",
    mutate: (f) => (node(f, "topic").paths[1].examples = []),
    nodeId: "topic",
    path: "/nodes/3/paths/1/examples",
  },
  FLOW_DUPLICATE_PATH: {
    code: "FLOW_DUPLICATE_PATH",
    mutate: (f) => (node(f, "topic").paths[1].id = "billing"),
    nodeId: "topic",
    path: "/nodes/3/paths/1/id",
  },
  FLOW_DUPLICATE_PATH_none: {
    code: "FLOW_DUPLICATE_PATH",
    mutate: (f) => (node(f, "topic").paths[1].id = "none"),
    nodeId: "topic",
    path: "/nodes/3/paths/1/id",
  },
  FLOW_UNKNOWN_VARIABLE: {
    code: "FLOW_UNKNOWN_VARIABLE",
    mutate: (f) => (node(f, "tell").text = "Hello {{nobody}}"),
    nodeId: "tell",
    path: "/nodes/6/text",
  },
  FLOW_UNKNOWN_VARIABLE_route_ref: {
    code: "FLOW_UNKNOWN_VARIABLE",
    mutate: (f) => (node(f, "tell").text = "{{route.greet}}"),
    nodeId: "tell",
    path: "/nodes/6/text",
  },
  FLOW_URL_NOT_HTTPS: {
    code: "FLOW_URL_NOT_HTTPS",
    mutate: (f) => (node(f, "lookup").url = "http://api.example.com/x"),
    nodeId: "lookup",
    path: "/nodes/4/url",
  },
  FLOW_URL_TEMPLATED_HOST: {
    code: "FLOW_URL_TEMPLATED_HOST",
    mutate: (f) =>
      (node(f, "lookup").url = "https://{{customerId}}.example.com/x"),
    nodeId: "lookup",
    path: "/nodes/4/url",
  },
  FLOW_URL_PRIVATE_HOST: {
    code: "FLOW_URL_PRIVATE_HOST",
    mutate: (f) => (node(f, "lookup").url = "https://169.254.169.254/latest"),
    nodeId: "lookup",
    path: "/nodes/4/url",
  },
  FLOW_URL_PRIVATE_HOST_tool_source: {
    code: "FLOW_URL_PRIVATE_HOST",
    mutate: (f) => (f.tools.toolSources[0].url = "https://localhost/mcp"),
    path: "/tools/toolSources/0/url",
  },
  FLOW_SECRET_UNDECLARED: {
    code: "FLOW_SECRET_UNDECLARED",
    mutate: (f) => (f.secrets = []),
    nodeId: "lookup",
    path: "/nodes/4/headers/Authorization/secret",
  },
  FLOW_SECRET_PREFIX: {
    code: "FLOW_SECRET_PREFIX",
    mutate: (f) => {
      f.secrets = ["CRM_TOKEN"];
      node(f, "lookup").headers.Authorization.secret = "CRM_TOKEN";
    },
    nodeId: "lookup",
    path: "/nodes/4/headers/Authorization/secret",
  },
  FLOW_MODEL_UNKNOWN_node: {
    code: "FLOW_MODEL_UNKNOWN",
    mutate: (f) => (node(f, "llmHelp").model = "big"),
    nodeId: "llmHelp",
    path: "/nodes/5/model",
  },
  FLOW_MODEL_UNKNOWN_use_missing: {
    code: "FLOW_MODEL_UNKNOWN",
    mutate: (f) => (f.models.classifier = { use: "ghost" }),
    path: "/models/classifier/use",
  },
  FLOW_MODEL_UNKNOWN_use_chain: {
    code: "FLOW_MODEL_UNKNOWN",
    mutate: (f) => {
      f.models.other = { use: "classifier" };
      f.models.third = { use: "other" };
    },
    path: "/models/third/use",
  },
  FLOW_MCP_SOURCE_UNKNOWN: {
    code: "FLOW_MCP_SOURCE_UNKNOWN",
    mutate: (f) => {
      f.nodes.push({
        id: "m",
        type: "mcp",
        source: "ghost",
        tool: "t",
        next: "end",
        onError: "end",
      });
      node(f, "tell").next = "m";
    },
    nodeId: "m",
    path: "/nodes/9/source",
  },
  FLOW_SECRET_MISSING: {
    code: "FLOW_SECRET_MISSING",
    mutate: () => {},
    ctx: { projectSecrets: ["AGENT_OPENROUTER_API_KEY"] },
    path: "/secrets/0",
  },
  FLOW_SERVICE_MISSING: {
    code: "FLOW_SERVICE_MISSING",
    mutate: (f) => {
      f.nodes.push({
        id: "m",
        type: "mcp",
        source: "service",
        tool: "t",
        next: "end",
        onError: "end",
      });
      node(f, "tell").next = "m";
    },
    ctx: { hasService: false },
    nodeId: "m",
    path: "/nodes/9/source",
  },
};

describe("validateFlow", () => {
  it("accepts the base flow", () => {
    const r = validateFlow(baseFlow());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.flow?.start).toBe("greet");
  });

  it("rejects non-objects", () => {
    expect(validateFlow(null).errors[0]?.code).toBe("FLOW_SCHEMA");
    expect(validateFlow([]).ok).toBe(false);
  });

  for (const [name, c] of Object.entries(cases)) {
    it(`reports ${name}`, () => {
      const f = baseFlow();
      c.mutate(f);
      const r = validateFlow(f, c.ctx);
      const hit = r.errors.find((e) => e.code === c.code && e.path === c.path);
      expect(hit, JSON.stringify(r.errors)).toBeDefined();
      expect(hit?.nodeId).toBe(c.nodeId);
      expect(r.ok).toBe(false);
    });
  }

  describe("negatives (valid shapes that must not report)", () => {
    const codesOf = (
      f: any,
      ctx?: Parameters<typeof validateFlow>[1],
    ): string[] => validateFlow(f, ctx).errors.map((e) => e.code);

    it("allows a loop that passes through listen", () => {
      expect(codesOf(baseFlow())).not.toContain("FLOW_BUSY_LOOP");
    });

    it("allows a loop that passes through wait", () => {
      const f = baseFlow();
      f.nodes.push(
        { id: "w", type: "wait", ms: 1000, next: "s" },
        { id: "s", type: "set", assign: { x: 1 }, next: "w" },
      );
      node(f, "greet").next = "w";
      expect(codesOf(f)).not.toContain("FLOW_BUSY_LOOP");
    });

    it("flags a self-loop without listen/wait", () => {
      const f = baseFlow();
      f.nodes.push({ id: "s", type: "set", assign: { x: 1 }, next: "s" });
      node(f, "greet").next = "s";
      expect(codesOf(f)).toContain("FLOW_BUSY_LOOP");
    });

    it("allows https public hosts, ports and userinfo-free IPv6 public literals", () => {
      for (const url of [
        "https://api.example.com:8443/x",
        "https://api.example.com/{{customerId}}",
        "https://8.8.8.8/x",
        "https://[2606:4700::1111]/x",
      ]) {
        const f = baseFlow();
        node(f, "lookup").url = url;
        expect(codesOf(f), url).toEqual([]);
      }
    });

    it("rejects private literals in every spelling", () => {
      for (const host of [
        "127.0.0.1",
        "10.1.2.3",
        "[::1]",
        "[::ffff:127.0.0.1]",
        "192.168.0.1:8080",
        "evil@10.0.0.1",
      ]) {
        const f = baseFlow();
        node(f, "lookup").url = `https://${host}/x`;
        expect(codesOf(f), host).toContain("FLOW_URL_PRIVATE_HOST");
      }
    });

    it("knows http/mcp/llm outputs and object variables", () => {
      const f = baseFlow();
      f.variables.profile = { type: "object" };
      node(f, "tell").text =
        "{{profile.name}} {{answer}} {{lookup.status}} {{route.topic}} {{error.lookup}}";
      expect(codesOf(f)).toEqual([]);
    });

    it("declared secrets and model keys count as declared", () => {
      const f = baseFlow();
      f.secrets = [];
      f.models.default.apiKeySecret = "AGENT_CRM_TOKEN";
      expect(codesOf(f)).not.toContain("FLOW_SECRET_UNDECLARED");
    });

    it("passes secrets/service checks when the context has them", () => {
      const f = baseFlow();
      f.nodes.push({
        id: "m",
        type: "mcp",
        source: "service",
        tool: "t",
        next: "end",
        onError: "end",
      });
      node(f, "tell").next = "m";
      expect(
        codesOf(f, {
          projectSecrets: ["AGENT_CRM_TOKEN", "AGENT_OPENROUTER_API_KEY"],
          hasService: true,
        }),
      ).toEqual([]);
    });

    it("an mcp node can use a declared mcp source", () => {
      const f = baseFlow();
      f.nodes.push({
        id: "m",
        type: "mcp",
        source: "crm",
        tool: "t",
        next: "end",
        onError: "end",
      });
      node(f, "tell").next = "m";
      expect(codesOf(f)).toEqual([]);
    });
  });

  describe("FLOW_TOOL_UNKNOWN (warning)", () => {
    it("warns for unknown mcp tool and llm tool names only when toolNames is given", () => {
      const f = baseFlow();
      f.nodes.push({
        id: "m",
        type: "mcp",
        source: "crm",
        tool: "lookup",
        next: "end",
        onError: "end",
      });
      node(f, "tell").next = "m";
      node(f, "llmHelp").tools = ["a", "b"];
      expect(validateFlow(f).warnings).toEqual([]);
      const r = validateFlow(f, { toolNames: ["a"] });
      expect(r.ok).toBe(true);
      expect(r.warnings.map((w) => [w.code, w.path])).toEqual([
        ["FLOW_TOOL_UNKNOWN", "/nodes/5/tools/1"],
        ["FLOW_TOOL_UNKNOWN", "/nodes/9/tool"],
      ]);
    });
  });

  describe("condition rules", () => {
    it("accepts nested groups and rejects a bad op", () => {
      const f = baseFlow();
      f.nodes.push({
        id: "c",
        type: "condition",
        rules: {
          all: [
            { var: "balance", op: "gt", value: 0 },
            { any: [{ var: "answer", op: "exists" }] },
          ],
        },
        then: "end",
        else: "end",
      });
      node(f, "tell").next = "c";
      expect(validateFlow(f).errors).toEqual([]);
      f.nodes[9].rules.all[0].op = "approx";
      const r = validateFlow(f);
      expect(
        r.errors.some((e) => e.code === "FLOW_SCHEMA" && e.nodeId === "c"),
      ).toBe(true);
    });
  });
});
