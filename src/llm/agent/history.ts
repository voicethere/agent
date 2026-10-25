import type { LlmMessage, LlmToolResult } from "../types.js";

type AssistantMessage = LlmMessage & { role: "assistant" };

interface Turn {
  turnId: string;
  messages: LlmMessage[];
}

/**
 * Conversation memory. A turn is one user message plus everything up to the next
 * user message. Only the last `maxTurns` turns are kept, so tool calls and their
 * results are never separated.
 */
export class ConversationHistory {
  private turns: Turn[] = [];
  private pendingNote: string | undefined;

  constructor(private readonly maxTurns: number) {}

  addUser(text: string, meta?: { turnId?: string }): void {
    this.turns.push({
      turnId: meta?.turnId ?? `turn-${this.turns.length + 1}`,
      messages: [{ role: "user", text }],
    });
    if (this.turns.length > this.maxTurns) {
      this.turns.splice(0, this.turns.length - this.maxTurns);
    }
  }

  addAssistant(msg: AssistantMessage, meta: { turnId: string }): void {
    this.turnFor(meta.turnId).messages.push(msg);
  }

  addToolResults(results: LlmToolResult[], meta: { turnId: string }): void {
    this.turnFor(meta.turnId).messages.push({ role: "tool", results });
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
          turn.messages.splice(i, 1);
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
