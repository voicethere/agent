import { AGENT_LOG_FIELDS_MAX_CHARS } from "../../runtime.js";
import type { McpToolInfo } from "./mcp-tool-source.js";

export const TOOLS_DISCOVERED_EVENT = "llm.tools.discovered";

const MAX_DISCOVERED_TOOLS = 128;
const MAX_DESCRIPTION_CHARS = 120;
/**
 * Must stay below AGENT_LOG_FIELDS_MAX_CHARS (src/runtime.ts): agentLog replaces
 * larger fields with a truncation marker, which would drop `event` and `tools`.
 */
const MAX_DISCOVERY_FIELDS_CHARS = AGENT_LOG_FIELDS_MAX_CHARS - 192;

export type DiscoveredTool = {
  name: string;
  description: string;
  exposed: boolean;
};

export type DiscoveryFields = {
  event: typeof TOOLS_DISCOVERED_EVENT;
  source: string;
  kind: "mcp" | "service";
  tools: DiscoveredTool[];
  truncated: boolean;
};

function cutCodePoints(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join("");
}

/** Structured log fields for one source: names, short descriptions and the exposed flag only. */
export function buildDiscoveryFields(
  source: string,
  kind: "mcp" | "service",
  all: McpToolInfo[],
  exposed: (name: string) => boolean,
): DiscoveryFields {
  const base = { event: TOOLS_DISCOVERED_EVENT, source, kind } as const;
  const acc: DiscoveredTool[] = [];
  for (const t of all.slice(0, MAX_DISCOVERED_TOOLS)) {
    const next: DiscoveredTool = {
      name: t.name,
      description: cutCodePoints(t.description, MAX_DESCRIPTION_CHARS),
      exposed: exposed(t.name),
    };
    const size = JSON.stringify({
      ...base,
      tools: [...acc, next],
      truncated: true,
    }).length;
    if (size > MAX_DISCOVERY_FIELDS_CHARS) break;
    acc.push(next);
  }
  return { ...base, tools: acc, truncated: acc.length < all.length };
}

/** Change detector: sorted tool names joined. */
export function toolsHash(all: McpToolInfo[]): string {
  return all
    .map((t) => t.name)
    .sort()
    .join("\n");
}
