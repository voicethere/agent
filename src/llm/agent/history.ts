import type { LlmMessage, LlmToolResult } from "../types.js";

type AssistantMessage = LlmMessage & { role: "assistant" };

interface Turn {
  turnId: string;
  messages: LlmMessage[];
}

/** Closed turn ids remembered so a late write is still recognized after trimming. */
const MAX_CLOSED_IDS = 256;

/**
 * Conversation memory. A turn is one user message plus everything up to the next
 * user message. Only the last `maxTurns` turns are kept, so tool calls and their
 * results are never separated.
 *
 * Providers need every tool result to be followed by an assistant message, and
 * never a user message straight after a tool result. `addUser` closes the turns
 * before it: an open tool round (the turn ends in a tool result) is removed, and
 * later writes to a closed turn (a cancelled turn whose tool finished late) are
 * dropped.
 */
export class ConversationHistory {
  private turns: Turn[] = [];
  private pendingNote: string | undefined;
  private readonly closed = new Set<string>();
  private readonly reported = new Set<string>();

  constructor(
    private readonly maxTurns: number,
    /** Called once per closed turn and kind when a late write is dropped. Metadata only. */
    private readonly onLateWrite?: (fields: {
      turnId: string;
      kind: "assistant" | "tool";
      count: number;
    }) => void,
  ) {}

  addUser(text: string, meta?: { turnId?: string }): void {
    for (const t of this.turns) {
      if (this.closed.has(t.turnId)) continue;
      closeOpenToolRound(t);
      this.markClosed(t.turnId);
    }
    this.turns.push({
      turnId: meta?.turnId ?? `turn-${this.turns.length + 1}`,
      messages: [{ role: "user", text }],
    });
    if (this.turns.length > this.maxTurns) {
      this.turns.splice(0, this.turns.length - this.maxTurns);
    }
  }

  /** False when the turn is already closed and the message was dropped. */
  addAssistant(msg: AssistantMessage, meta: { turnId: string }): boolean {
    if (this.closed.has(meta.turnId)) {
      this.reportLate(meta.turnId, "assistant", 1);
      return false;
    }
    this.turnFor(meta.turnId).messages.push(msg);
    return true;
  }

  /** False when the turn is already closed and the results were dropped. */
  addToolResults(results: LlmToolResult[], meta: { turnId: string }): boolean {
    if (this.closed.has(meta.turnId)) {
      this.reportLate(meta.turnId, "tool", results.length);
      return false;
    }
    this.turnFor(meta.turnId).messages.push({ role: "tool", results });
    return true;
  }

  /**
   * The caller heard only `playedText` of the last assistant message of the turn.
   * Tool calls stay, because the tools already ran.
   */
  replaceAssistantText(
    turnId: string,
    playedText: string,
    note?: string,
  ): void {
    const turn = this.turns.find((t) => t.turnId === turnId);
    if (turn) {
      for (let i = turn.messages.length - 1; i >= 0; i -= 1) {
        const m = turn.messages[i];
        if (m.role !== "assistant") continue;
        if (m.toolCalls && m.toolCalls.length > 0) {
          m.text = playedText;
        } else if (playedText.length === 0) {
          // After a tool result the answer stays: without it the next user
          // message follows the tool result directly, and Amazon Nova (via
          // OpenRouter) fails that request mid-stream with 424 "Model produced
          // invalid sequence as part of ToolUse". The interruption note tells
          // the model the caller did not hear it.
          if (turn.messages[i - 1]?.role !== "tool") turn.messages.splice(i, 1);
        } else {
          // providerState carries the full original text, so rebuild from text.
          m.text = playedText;
          delete m.providerState;
        }
        break;
      }
    }
    if (note) this.pendingNote = note;
  }

  setPendingNote(note: string): void {
    this.pendingNote = note;
  }

  takePendingNote(): string | undefined {
    const note = this.pendingNote;
    this.pendingNote = undefined;
    return note;
  }

  messages(): LlmMessage[] {
    return this.turns.flatMap((t) => t.messages);
  }

  private reportLate(
    turnId: string,
    kind: "assistant" | "tool",
    count: number,
  ): void {
    const key = `${turnId}:${kind}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    if (this.reported.size > MAX_CLOSED_IDS) {
      const oldest = this.reported.values().next().value;
      if (oldest !== undefined) this.reported.delete(oldest);
    }
    this.onLateWrite?.({ turnId, kind, count });
  }

  private markClosed(turnId: string): void {
    this.closed.add(turnId);
    if (this.closed.size > MAX_CLOSED_IDS) {
      const oldest = this.closed.values().next().value;
      if (oldest !== undefined) this.closed.delete(oldest);
    }
  }

  private turnFor(turnId: string): Turn {
    let turn = this.turns.find((t) => t.turnId === turnId);
    if (!turn) {
      turn = { turnId, messages: [] };
      this.turns.push(turn);
      if (this.turns.length > this.maxTurns) {
        this.turns.splice(0, this.turns.length - this.maxTurns);
      }
    }
    return turn;
  }
}

/**
 * A turn that ends in tool results, or in a tool call whose results never came,
 * has no answer to them. Remove those results and turn the assistant message
 * that asked for them into plain text: kept when it has text (a spoken
 * preamble), removed when it has none.
 */
function closeOpenToolRound(turn: Turn): void {
  const msgs = turn.messages;
  while (msgs.length > 0 && msgs[msgs.length - 1].role === "tool") msgs.pop();
  const i = msgs.length - 1;
  const m = msgs[i];
  if (!m || m.role !== "assistant" || !m.toolCalls || m.toolCalls.length === 0)
    return;
  delete m.toolCalls;
  delete m.providerState;
  if (!m.text) msgs.splice(i, 1);
}
