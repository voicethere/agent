import { defineTool } from "../agent/define-tool.js";
import type { CustomTool } from "../mcp/tool-registry.js";
import { KnowledgeIndexError, type KnowledgeBase } from "./types.js";

export interface SearchKnowledgeToolOptions {
  /** Default 4. */
  topK?: number;
  /** Cut of the returned text. Default 4000. */
  maxChars?: number;
  /** Receives the error code only, never query or chunk text. */
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export function searchKnowledgeTool(
  kb: KnowledgeBase,
  opts: SearchKnowledgeToolOptions = {},
): CustomTool {
  const topK = opts.topK ?? 4;
  const maxChars = opts.maxChars ?? 4000;
  return defineTool<{ query?: unknown; k?: unknown }>({
    name: "search_knowledge",
    description:
      "Search the project's knowledge base. Use it for questions about the product, documentation or facts you are not sure of.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 1, maxLength: 500 },
        k: { type: "integer", minimum: 1, maximum: 10 },
      },
    },
    handler: async (args) => {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (query.length === 0 || query.length > 500) {
        return "Knowledge search needs a query of 1 to 500 characters.";
      }
      const k =
        typeof args.k === "number" && Number.isInteger(args.k)
          ? Math.min(10, Math.max(1, args.k))
          : topK;
      let hits;
      try {
        hits = await kb.search(query, k);
      } catch (err) {
        const code =
          err instanceof KnowledgeIndexError ? err.code : "KB_UNKNOWN";
        opts.log?.("knowledge search failed", { code });
        return "Knowledge search is unavailable right now.";
      }
      if (hits.length === 0) return "No matching knowledge found.";
      const text = hits
        .map(
          (h, i) =>
            `[${i + 1}] ${h.title} (score ${h.score.toFixed(2)})\n${h.text}`,
        )
        .join("\n\n");
      return text.length > maxChars ? text.slice(0, maxChars) : text;
    },
  });
}
