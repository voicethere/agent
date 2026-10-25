import { describe, expect, it } from "vitest";

import { ConversationHistory } from "../../../src/llm/agent/history.js";

describe("ConversationHistory", () => {
  it("keeps the last N turns", () => {
    const h = new ConversationHistory(2);
    for (const n of [1, 2, 3]) {
      h.addUser(`q${n}`, { turnId: `t${n}` });
      h.addAssistant(
        {
          role: "assistant",
          text: `a${n}`,
          toolCalls: [{ id: `c${n}`, name: "x", input: {} }],
        },
        { turnId: `t${n}` },
      );
      h.addToolResults([{ callId: `c${n}`, name: "x", content: "r" }], {
        turnId: `t${n}`,
      });
    }
    const texts = h
      .messages()
      .map((m) => (m.role === "tool" ? "tool" : m.text));
    expect(texts).toEqual(["q2", "a2", "tool", "q3", "a3", "tool"]);
  });

  it("replaceAssistantText updates the last assistant message of the turn", () => {
    const h = new ConversationHistory(5);
    h.addUser("q", { turnId: "t1" });
    h.addAssistant(
      {
        role: "assistant",
        text: "first",
        toolCalls: [{ id: "c", name: "x", input: {} }],
      },
      { turnId: "t1" },
    );
    h.addToolResults([{ callId: "c", name: "x", content: "r" }], {
      turnId: "t1",
    });
    h.addAssistant(
      { role: "assistant", text: "Full answer.", providerState: { raw: 1 } },
      { turnId: "t1" },
    );
    h.replaceAssistantText("t1", "Full", "(note)");
    const msgs = h.messages();
    expect(msgs[1]).toMatchObject({ text: "first" });
    expect(msgs[1]).toHaveProperty("toolCalls");
    expect(msgs[3]).toMatchObject({ role: "assistant", text: "Full" });
    expect(msgs[3]).not.toHaveProperty("providerState");
    expect(h.takePendingNote()).toBe("(note)");
    expect(h.takePendingNote()).toBeUndefined();
  });
});
