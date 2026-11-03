import { agentLog } from "../../runtime.js";
import { McpToolSource } from "../mcp/mcp-tool-source.js";
import type { McpToolSourceOptions } from "../mcp/mcp-tool-source.js";
import { ToolRegistry } from "../mcp/tool-registry.js";
import type { CustomTool } from "../mcp/tool-registry.js";
import type { LlmAgentToolSource } from "./config.js";
import { secretValuesFromEnv } from "./redact.js";
import type { ToolCallLogMode } from "./redact.js";

function nonEmpty(v: string | undefined): v is string {
  return v !== undefined && v.length > 0;
}

export interface BuildToolRegistryOptions {
  env: Record<string, string | undefined>;
  toolSources: LlmAgentToolSource[];
  customTools: CustomTool[];
  /** Environment variable names whose values are removed from tool-call logs (source secrets are added here). */
  secretNames: string[];
  toolCallLogs: ToolCallLogMode;
  servicePath: string;
  makeSource?: (o: McpToolSourceOptions) => McpToolSource;
}

/**
 * Builds a ToolRegistry from `toolSources` (the project service and external
 * MCP servers) and custom tools, and starts the sources. Shared by the LLM
 * agent and the flow agent.
 */
export function buildToolRegistry(o: BuildToolRegistryOptions): {
  registry: ToolRegistry;
  serviceSource: McpToolSource | undefined;
} {
  const { env } = o;
  const makeSource =
    o.makeSource ?? ((x: McpToolSourceOptions) => new McpToolSource(x));
  const reg = new ToolRegistry({
    log: (level, message, fields) => agentLog(level, message, fields ?? {}),
    toolCallLog: {
      mode: o.toolCallLogs,
      secretValues: secretValuesFromEnv(env, [
        ...o.secretNames,
        ...o.toolSources.flatMap((src) => {
          if (src.kind !== "mcp" || !src.auth) return [];
          if (src.auth.type === "bearer") return [src.auth.secret];
          if (src.auth.type === "headers")
            return Object.values(src.auth.headers);
          return [];
        }),
      ]),
      emit: (fields, sid) =>
        agentLog("info", "llm tool call", { ...fields }, sid),
    },
  });
  for (const tool of o.customTools) reg.addCustomTool(tool);
  let serviceSource: McpToolSource | undefined;
  const sources: McpToolSource[] = [];
  for (const src of o.toolSources) {
    if (src.kind === "service") {
      const base = env.AGENT_SERVICE_URL;
      if (!nonEmpty(base)) {
        agentLog(
          "warn",
          "toolSources: service configured but this project has no service",
        );
        continue;
      }
      const headers: Record<string, string> = {};
      const token = env.AGENT_SERVICE_TOKEN;
      if (nonEmpty(token)) {
        headers.Authorization = `Bearer ${token}`;
      } else {
        agentLog("warn", "toolSources: AGENT_SERVICE_TOKEN is not set");
      }
      const source = makeSource({
        name: "service",
        kind: "service",
        url: `${base}${src.path ?? o.servicePath}`,
        headers,
        allow: src.allow,
        deny: src.deny,
        log: (level, message, fields) => agentLog(level, message, fields ?? {}),
      });
      serviceSource = source;
      sources.push(source);
    } else {
      const headers: Record<string, string> = {};
      let missing: string | undefined;
      const auth = src.auth ?? { type: "none" as const };
      if (auth.type === "bearer") {
        const v = env[auth.secret];
        if (nonEmpty(v)) headers.Authorization = `Bearer ${v}`;
        else missing = auth.secret;
      } else if (auth.type === "headers") {
        for (const [header, envName] of Object.entries(auth.headers)) {
          const v = env[envName];
          if (nonEmpty(v)) headers[header] = v;
          else missing = envName;
        }
      }
      if (missing) {
        agentLog(
          "warn",
          `toolSources: ${src.name} skipped, environment variable ${missing} is not set`,
        );
        continue;
      }
      sources.push(
        makeSource({
          name: src.name,
          url: src.url,
          headers,
          allow: src.allow,
          deny: src.deny,
          log: (level, message, fields) =>
            agentLog(level, message, fields ?? {}),
        }),
      );
    }
  }
  for (const source of sources) {
    reg.addSource(source);
    source.start();
  }
  return { registry: reg, serviceSource };
}
