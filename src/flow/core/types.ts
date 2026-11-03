import type { LlmAgentToolSource } from "../../llm/agent/config.js";
import type { LlmProviderId } from "../../llm/types.js";

export interface FlowModel {
  provider: LlmProviderId;
  model: string;
  apiKeySecret: string;
  baseUrl?: string;
}

export type FlowModelEntry = FlowModel | { use: string };

export type FlowVariableType = "string" | "number" | "boolean" | "object";

export interface FlowVariable {
  type: FlowVariableType;
  default?: unknown;
}

export type FlowRuleOp =
  "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "contains" | "exists";

export interface FlowRule {
  var: string;
  op: FlowRuleOp;
  value?: unknown;
}

export type FlowRuleGroup =
  { all: (FlowRule | FlowRuleGroup)[] } | { any: (FlowRule | FlowRuleGroup)[] };

export interface FlowNodeBase {
  id: string;
  label?: string;
}

export interface FlowSpeakNode extends FlowNodeBase {
  type: "speak";
  text: string;
  interruptible?: boolean;
  next: string;
}

export interface FlowListenNode extends FlowNodeBase {
  type: "listen";
  timeoutMs?: number;
  next: string;
  onNoInput: string;
}

export interface FlowWaitNode extends FlowNodeBase {
  type: "wait";
  ms: number;
  next: string;
}

export interface FlowRoutePath {
  id: string;
  examples: string[];
  keywords?: string[];
  next: string;
}

export interface FlowRouteNode extends FlowNodeBase {
  type: "route";
  input?: string;
  paths: FlowRoutePath[];
  onNone: string;
  onError: string;
  timeoutMs?: number;
  model?: string;
  historyTurns?: number;
}

export interface FlowConditionNode extends FlowNodeBase {
  type: "condition";
  rules: FlowRuleGroup;
  then: string;
  else: string;
}

export interface FlowSetNode extends FlowNodeBase {
  type: "set";
  assign: Record<string, string | number | boolean>;
  next: string;
}

export type FlowHttpHeader = string | { secret: string; prefix?: string };

export interface FlowHttpNode extends FlowNodeBase {
  type: "http";
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, FlowHttpHeader>;
  body?: unknown;
  /** variable name -> JSON Pointer into the response body */
  map?: Record<string, string>;
  timeoutMs?: number;
  next: string;
  onError: string;
}

export interface FlowMcpNode extends FlowNodeBase {
  type: "mcp";
  source: string;
  tool: string;
  args?: unknown;
  map?: Record<string, string>;
  timeoutMs?: number;
  next: string;
  onError: string;
}

export interface FlowLlmNode extends FlowNodeBase {
  type: "llm";
  instructions: string;
  send: "conversation" | "message";
  message?: string;
  historyTurns?: number;
  model?: string;
  speak?: boolean;
  saveAs?: string;
  tools?: "none" | "all" | string[];
  maxRounds?: number;
  filler?: { text: string; afterMs: number };
  next: string;
  onError: string;
}

export interface FlowEndNode extends FlowNodeBase {
  type: "end";
  reason: string;
  text?: string;
}

export type FlowNode =
  | FlowSpeakNode
  | FlowListenNode
  | FlowWaitNode
  | FlowRouteNode
  | FlowConditionNode
  | FlowSetNode
  | FlowHttpNode
  | FlowMcpNode
  | FlowLlmNode
  | FlowEndNode;

export type FlowNodeType = FlowNode["type"];

export interface FlowDocument {
  $schema?: string;
  version: 1;
  start: string;
  models: Record<string, FlowModelEntry>;
  secrets?: string[];
  variables?: Record<string, FlowVariable>;
  tools?: { toolSources?: LlmAgentToolSource[] };
  nodes: FlowNode[];
  /** Editor-only data; ignored by compile. */
  ui?: Record<string, unknown>;
}

export interface FlowIssue {
  code: string;
  message: string;
  nodeId?: string;
  /** JSON Pointer into the document. */
  path: string;
}

export interface FlowValidationContext {
  projectSecrets?: string[];
  toolNames?: string[];
  hasService?: boolean;
}

export interface FlowValidationResult {
  ok: boolean;
  flow?: FlowDocument;
  errors: FlowIssue[];
  warnings: FlowIssue[];
}
