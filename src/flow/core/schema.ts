export const FLOW_SCHEMA_VERSION = 1;

export const FLOW_LIMITS = {
  maxNodes: 500,
  maxPathsPerRoute: 20,
  maxExamplesPerPath: 50,
  maxExampleChars: 200,
  maxTextChars: 4000,
  maxWaitMs: 60_000,
  maxHttpTimeoutMs: 15_000,
} as const;

export const FLOW_NODE_ID_PATTERN = "^[A-Za-z][A-Za-z0-9_-]{0,63}$";

/** The JSON Schema subset used here (validated by `validate.ts`). */
export type JsonSchema = Record<string, unknown>;

const ID: JsonSchema = { type: "string", pattern: FLOW_NODE_ID_PATTERN };
/** A node reference: unknown ids are reported as FLOW_UNKNOWN_TARGET, not shape errors. */
const TARGET: JsonSchema = { type: "string" };
const TEXT: JsonSchema = {
  type: "string",
  maxLength: FLOW_LIMITS.maxTextChars,
};
const STR: JsonSchema = { type: "string" };
const STR_ARRAY: JsonSchema = { type: "array", items: STR };
const STR_MAP: JsonSchema = { type: "object", additionalProperties: STR };
const INT_MIN1: JsonSchema = { type: "integer", minimum: 1 };
const INT_MIN0: JsonSchema = { type: "integer", minimum: 0 };

function node(
  type: string,
  required: string[],
  props: Record<string, JsonSchema>,
): JsonSchema {
  return {
    type: "object",
    properties: {
      id: ID,
      type: { const: type },
      label: STR,
      ...props,
    },
    required: ["id", "type", ...required],
    additionalProperties: false,
  };
}

const RULE_OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "contains", "exists"];

const DEFS: Record<string, JsonSchema> = {
  rule: {
    type: "object",
    properties: {
      var: STR,
      op: { enum: RULE_OPS },
      value: {},
    },
    required: ["var", "op"],
    additionalProperties: false,
  },
  ruleGroup: {
    oneOf: [
      {
        type: "object",
        properties: {
          all: {
            type: "array",
            items: {
              oneOf: [{ $ref: "#/$defs/rule" }, { $ref: "#/$defs/ruleGroup" }],
            },
          },
        },
        required: ["all"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          any: {
            type: "array",
            items: {
              oneOf: [{ $ref: "#/$defs/rule" }, { $ref: "#/$defs/ruleGroup" }],
            },
          },
        },
        required: ["any"],
        additionalProperties: false,
      },
    ],
  },
};

export const FLOW_NODE_SCHEMAS: Record<string, JsonSchema> = {
  speak: node("speak", ["text", "next"], {
    text: TEXT,
    interruptible: { type: "boolean" },
    next: TARGET,
  }),
  listen: node("listen", ["next", "onNoInput"], {
    timeoutMs: INT_MIN1,
    next: TARGET,
    onNoInput: TARGET,
  }),
  wait: node("wait", ["ms", "next"], {
    ms: { type: "integer", minimum: 0, maximum: FLOW_LIMITS.maxWaitMs },
    next: TARGET,
  }),
  route: node("route", ["paths", "onNone", "onError"], {
    input: TEXT,
    paths: {
      type: "array",
      maxItems: FLOW_LIMITS.maxPathsPerRoute,
      items: {
        type: "object",
        properties: {
          id: ID,
          examples: {
            type: "array",
            maxItems: FLOW_LIMITS.maxExamplesPerPath,
            items: { type: "string", maxLength: FLOW_LIMITS.maxExampleChars },
          },
          keywords: STR_ARRAY,
          next: TARGET,
        },
        required: ["id", "examples", "next"],
        additionalProperties: false,
      },
    },
    onNone: TARGET,
    onError: TARGET,
    timeoutMs: INT_MIN1,
    model: STR,
    historyTurns: INT_MIN0,
  }),
  condition: node("condition", ["rules", "then", "else"], {
    rules: { $ref: "#/$defs/ruleGroup" },
    then: TARGET,
    else: TARGET,
  }),
  set: node("set", ["assign", "next"], {
    assign: {
      type: "object",
      additionalProperties: {
        oneOf: [TEXT, { type: "number" }, { type: "boolean" }],
      },
    },
    next: TARGET,
  }),
  http: node("http", ["method", "url", "next", "onError"], {
    method: { enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
    url: TEXT,
    headers: {
      type: "object",
      additionalProperties: {
        oneOf: [
          STR,
          {
            type: "object",
            properties: { secret: STR, prefix: STR },
            required: ["secret"],
            additionalProperties: false,
          },
        ],
      },
    },
    body: {},
    map: STR_MAP,
    timeoutMs: {
      type: "integer",
      minimum: 1,
      maximum: FLOW_LIMITS.maxHttpTimeoutMs,
    },
    next: TARGET,
    onError: TARGET,
  }),
  mcp: node("mcp", ["source", "tool", "next", "onError"], {
    source: STR,
    tool: STR,
    args: {},
    map: STR_MAP,
    timeoutMs: INT_MIN1,
    next: TARGET,
    onError: TARGET,
  }),
  llm: node("llm", ["instructions", "send", "next", "onError"], {
    instructions: TEXT,
    send: { enum: ["conversation", "message"] },
    message: TEXT,
    historyTurns: INT_MIN0,
    model: STR,
    speak: { type: "boolean" },
    saveAs: STR,
    tools: { oneOf: [{ enum: ["none", "all"] }, STR_ARRAY] },
    maxRounds: INT_MIN1,
    filler: {
      type: "object",
      properties: { text: TEXT, afterMs: INT_MIN0 },
      required: ["text", "afterMs"],
      additionalProperties: false,
    },
    next: TARGET,
    onError: TARGET,
  }),
  end: node("end", ["reason"], {
    reason: STR,
    text: TEXT,
  }),
};

const MODEL: JsonSchema = {
  type: "object",
  properties: {
    provider: { enum: ["openai", "anthropic", "gemini", "openrouter"] },
    model: STR,
    apiKeySecret: STR,
    baseUrl: STR,
  },
  required: ["provider", "model", "apiKeySecret"],
  additionalProperties: false,
};

const TOOL_SOURCE: JsonSchema = {
  oneOf: [
    {
      type: "object",
      properties: {
        kind: { const: "service" },
        path: STR,
        allow: STR_ARRAY,
        deny: STR_ARRAY,
      },
      required: ["kind"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "mcp" },
        name: STR,
        url: STR,
        auth: {
          oneOf: [
            {
              type: "object",
              properties: { type: { const: "none" } },
              required: ["type"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: { type: { const: "bearer" }, secret: STR },
              required: ["type", "secret"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: { type: { const: "headers" }, headers: STR_MAP },
              required: ["type", "headers"],
              additionalProperties: false,
            },
          ],
        },
        allow: STR_ARRAY,
        deny: STR_ARRAY,
      },
      required: ["kind", "name", "url"],
      additionalProperties: false,
    },
  ],
};

function docSchema(nodeItems: JsonSchema): JsonSchema {
  return {
    type: "object",
    properties: {
      $schema: STR,
      version: { const: FLOW_SCHEMA_VERSION },
      start: STR,
      models: {
        type: "object",
        additionalProperties: {
          oneOf: [
            MODEL,
            {
              type: "object",
              properties: { use: STR },
              required: ["use"],
              additionalProperties: false,
            },
          ],
        },
      },
      secrets: STR_ARRAY,
      variables: {
        type: "object",
        additionalProperties: {
          type: "object",
          properties: {
            type: { enum: ["string", "number", "boolean", "object"] },
            default: {},
          },
          required: ["type"],
          additionalProperties: false,
        },
      },
      tools: {
        type: "object",
        properties: { toolSources: { type: "array", items: TOOL_SOURCE } },
        additionalProperties: false,
      },
      nodes: {
        type: "array",
        maxItems: FLOW_LIMITS.maxNodes,
        items: nodeItems,
      },
      ui: { type: "object" },
    },
    required: ["version", "start", "models", "nodes"],
    additionalProperties: false,
    $defs: DEFS,
  };
}

/** Document shell; node bodies are checked per `type` against FLOW_NODE_SCHEMAS. */
export const FLOW_DOC_SHELL_SCHEMA: JsonSchema = docSchema({
  type: "object",
});

/** Exported JSON Schema (draft 2020-12) for editors and the CLI. */
export const FLOW_JSON_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "VoiceThere conversation flow",
  ...docSchema({ oneOf: Object.values(FLOW_NODE_SCHEMAS) }),
};
