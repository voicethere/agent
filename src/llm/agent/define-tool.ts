import type { CustomTool, ToolCallContext } from "../mcp/tool-registry.js";

export function defineTool<A = unknown>(t: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Hide the tool from the model and refuse calls unless the session user is verified. */
  requiresVerifiedUser?: boolean;
  handler: (args: A, ctx: ToolCallContext) => Promise<string> | string;
}): CustomTool {
  return {
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    ...(t.requiresVerifiedUser ? { requiresVerifiedUser: true } : {}),
    handler: async (args, ctx) => String(await t.handler(args as A, ctx)),
  };
}
