import type { CustomTool, ToolCallContext } from "../mcp/tool-registry.js";

export function defineTool<A = unknown>(t: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: A, ctx: ToolCallContext) => Promise<string> | string;
}): CustomTool {
  return {
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    handler: async (args, ctx) => String(await t.handler(args as A, ctx)),
  };
}
