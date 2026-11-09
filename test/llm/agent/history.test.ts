import { describe, expect, it } from "vitest";

import { ConversationHistory } from "../../../src/llm/agent/history.js";
import { assertProviderOrder } from "./provider-order.js";

const toolTurn = (h: ConversationHistory, turnId: string, text = "") => {
  h.addUser(`q-${turnId}`, { turnId });
  h.addAssistant(
    {
      role: "assistant",
      text,
      toolCalls: [{ id: `c-${turnId}`, name: "lookup", input: {} }],
      providerState: { raw: 1 },
    },
    { turnId },
  );
  h.addToolResults([{ callId: `c-${turnId}`, name: "lookup", content: "r" }], {
    turnId,
  });
};

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
    // Turn 2 ended in a tool result with no answer: closing it on q3 keeps
    // the spoken preamble a2 as plain text and drops the open tool round.
    expect(texts).toEqual(["q2", "a2", "q3", "a3", "tool"]);
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

  it("an interruption with nothing played keeps the answer that follows a tool result", () => {
    // Store showcase: a chat question arrived before the reply after
    // search_knowledge played. Dropping that reply left tool -> user, which
    // Nova rejects mid-stream (424 invalid ToolUse sequence).
    const h = new ConversationHistory(5);
    h.addUser("What is your return policy?", { turnId: "t1" });
    h.addAssistant(
      {
        role: "assistant",
        text: "",
        toolCalls: [{ id: "c", name: "search_knowledge", input: {} }],
      },
      { turnId: "t1" },
    );
    h.addToolResults(
      [{ callId: "c", name: "search_knowledge", content: "r" }],
      {
        turnId: "t1",
      },
    );
    h.addAssistant(
      { role: "assistant", text: "Within 60 days." },
      { turnId: "t1" },
    );
    h.replaceAssistantText("t1", "", "(note)");
    h.addUser("How much is the Ridgeline 2 tent?", { turnId: "t2" });
    const roles = h.messages().map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "assistant", "user"]);
    expect(h.messages()[3]).toMatchObject({ text: "Within 60 days." });
    assertProviderOrder(h.messages());
  });

  it("an interruption with nothing played still drops a plain answer", () => {
    const h = new ConversationHistory(5);
    h.addUser("q", { turnId: "t1" });
    h.addAssistant({ role: "assistant", text: "a" }, { turnId: "t1" });
    h.replaceAssistantText("t1", "", "(note)");
    expect(h.messages().map((m) => m.role)).toEqual(["user"]);
    assertProviderOrder(h.messages());
  });

  it("a turn that ends in a tool result never leaves user after tool", () => {
    const h = new ConversationHistory(5);
    toolTurn(h, "t1");
    h.addUser("next", { turnId: "t2" });
    expect(h.messages().map((m) => m.role)).toEqual(["user", "user"]);
    assertProviderOrder(h.messages());
  });

  it("a preamble before the tool call survives closing the round", () => {
    const h = new ConversationHistory(5);
    toolTurn(h, "t1", "Let me check.");
    h.addUser("next", { turnId: "t2" });
    const msgs = h.messages();
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(msgs[1]).toEqual({ role: "assistant", text: "Let me check." });
    assertProviderOrder(msgs);
  });

  it("a tool result that resolves after the next addUser is dropped and order stays valid", () => {
    const late: unknown[] = [];
    const h = new ConversationHistory(5, (f) => late.push(f));
    h.addUser("q1", { turnId: "t1" });
    h.addAssistant(
      {
        role: "assistant",
        text: "",
        toolCalls: [{ id: "c1", name: "lookup", input: {} }],
      },
      { turnId: "t1" },
    );
    h.addUser("q2", { turnId: "t2" });
    const r1 = h.addToolResults(
      [{ callId: "c1", name: "lookup", content: "late" }],
      { turnId: "t1" },
    );
    const r2 = h.addToolResults(
      [{ callId: "c1", name: "lookup", content: "late" }],
      { turnId: "t1" },
    );
    const r3 = h.addAssistant(
      { role: "assistant", text: "late answer" },
      { turnId: "t1" },
    );
    expect([r1, r2, r3]).toEqual([false, false, false]);
    expect(late).toEqual([
      { turnId: "t1", kind: "tool", count: 1 },
      { turnId: "t1", kind: "assistant", count: 1 },
    ]);
    expect(JSON.stringify(late)).not.toContain("late answer");
    expect(h.messages().map((m) => m.role)).toEqual(["user", "user"]);
    assertProviderOrder(h.messages());
  });
});
