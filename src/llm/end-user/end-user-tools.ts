import { getUserHistory } from "../../runtime.js";
import { defineTool } from "../agent/define-tool.js";
import type { CustomTool } from "../mcp/tool-registry.js";

const MAX_CHARS = 6000;

/** Loads earlier conversations of the session's user. Replaceable in tests. */
export type LoadUserHistory = typeof getUserHistory;

/**
 * Built-in tools bound to the session's end user. The user comes from the session
 * (`ctx.user`), never from the model's input.
 */
export function endUserTools(
  load: LoadUserHistory = getUserHistory,
): CustomTool[] {
  return [
    defineTool<{ limit?: unknown }>({
      name: "get_previous_conversations",
      description:
        "Read earlier conversations with this verified user, to avoid repeating questions or steps they already went through.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { limit: { type: "integer", minimum: 1, maximum: 10 } },
      },
      requiresVerifiedUser: true,
      handler: async (args, ctx) => {
        const limit =
          typeof args.limit === "number" && Number.isInteger(args.limit)
            ? Math.min(10, Math.max(1, args.limit))
            : 3;
        const res = await load(ctx.sessionId, { limit });
        if (!res.ok) return "Earlier conversations are unavailable right now.";
        if (res.conversations.length === 0) {
          return "No earlier conversations with this user.";
        }
        const text = res.conversations
          .map(
            (c, i) =>
              `Conversation ${i + 1} (${c.sessionStartedAt}):\n` +
              c.turns.map((t) => `${t.role}: ${t.text}`).join("\n"),
          )
          .join("\n\n");
        return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
      },
    }),
    defineTool({
      name: "get_current_user",
      description:
        "Who the current user is: their id, whether they are verified, and the attributes the customer's system gave.",
      inputSchema: { type: "object", additionalProperties: false },
      handler: (_args, ctx) =>
        JSON.stringify(
          ctx.user
            ? {
                id: ctx.user.id,
                verified: ctx.user.verified,
                attributes: ctx.user.attributes ?? {},
              }
            : { id: null, verified: false, attributes: {} },
        ),
    }),
  ];
}
