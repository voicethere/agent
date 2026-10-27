import type { McpToolInfo } from "./mcp-tool-source.js";

export const TOOLS_DISCOVERED_EVENT = "llm.tools.discovered";

const MAX_DISCOVERED_TOOLS = 128;
const MAX_DESCRIPTION_CHARS = 200;

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
  return {
    event: TOOLS_DISCOVERED_EVENT,
    source,
    kind,
    tools: all.slice(0, MAX_DISCOVERED_TOOLS).map((t) => ({
      name: t.name,
      description: cutCodePoints(t.description, MAX_DESCRIPTION_CHARS),
      exposed: exposed(t.name),
    })),
    truncated: all.length > MAX_DISCOVERED_TOOLS,
  };
}

/** Change detector: sorted tool names joined. */
export function toolsHash(all: McpToolInfo[]): string {
  return all
    .map((t) => t.name)
    .sort()
    .join("\n");
}
