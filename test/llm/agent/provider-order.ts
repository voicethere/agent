import { expect } from "vitest";

import type { LlmMessage } from "../../../src/llm/types.js";

/** Provider order: no user straight after a tool result, every tool call answered by a tool result. */
export function assertProviderOrder(messages: LlmMessage[]): void {
  messages.forEach((m, i) => {
    const next = messages[i + 1];
    if (m.role === "tool") {
      expect(next?.role, `tool at ${i} followed by user`).not.toBe("user");
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      expect(next?.role, `tool call at ${i} not followed by tool`).toBe("tool");
    }
  });
}
