import { defineAgent, sendToClient } from "@voicethere/agent";
import {
  createLlmAgent,
  defineTool,
  type CreateLlmAgentOptions,
} from "@voicethere/agent/llm";
import { openai } from "@voicethere/agent/llm/openai";
import config from "./voicethere.llm.json";
import systemPrompt from "./prompt.md";
import {
  Board,
  NOTE_COLORS,
  parseBoardMessage,
  type BoardMessage,
  type NoteColor,
} from "./board";

// One board per session, kept in the agent process. Clients send board
// messages on the data channel (see README.md); everything else goes to the
// LLM as chat. The board is dropped when the session ends.
const boards = new Map<string, Board>();

function boardFor(sessionId: string): Board {
  let board = boards.get(sessionId);
  if (!board) {
    board = new Board();
    boards.set(sessionId, board);
  }
  return board;
}

function broadcast(sessionId: string): void {
  sendToClient(sessionId, { type: "board", notes: boardFor(sessionId).list() });
}

function apply(sessionId: string, m: BoardMessage): void {
  const board = boardFor(sessionId);
  switch (m.type) {
    case "note.add":
      board.add({ ...m, author: "user" });
      break;
    case "note.update": {
      const { type: _type, id, ...patch } = m;
      board.update(id, patch);
      break;
    }
    case "note.remove":
      board.remove(m.id);
      break;
    case "board.sync":
      break;
  }
  broadcast(sessionId);
}

const colorSchema = { type: "string", enum: [...NOTE_COLORS] };

const listNotes = defineTool({
  name: "list_notes",
  description: "List every note on the shared board.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: (_args, ctx) => {
    const notes = boardFor(ctx.sessionId).list();
    if (notes.length === 0) return "The board is empty.";
    return notes
      .map((n) => `${n.id}: ${n.text} (${n.color}, ${n.author})`)
      .join("\n");
  },
});

const addNote = defineTool<{ text: string; color?: NoteColor }>({
  name: "add_note",
  description: "Add a note to the shared board. Text is 1 to 200 characters.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" }, color: colorSchema },
    required: ["text"],
    additionalProperties: false,
  },
  handler: ({ text, color }, ctx) => {
    const res = boardFor(ctx.sessionId).add({ text, color, author: "ai" });
    if (!res.ok) return res.error;
    broadcast(ctx.sessionId);
    return `Added note ${res.value.id}.`;
  },
});

const updateNote = defineTool<{
  id: string;
  text?: string;
  color?: NoteColor;
  x?: number;
  y?: number;
}>({
  name: "update_note",
  description:
    "Change a note's text, color or position (x and y between 0 and 1).",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      text: { type: "string" },
      color: colorSchema,
      x: { type: "number" },
      y: { type: "number" },
    },
    required: ["id"],
    additionalProperties: false,
  },
  handler: ({ id, ...patch }, ctx) => {
    const res = boardFor(ctx.sessionId).update(id, patch);
    if (!res.ok) return res.error;
    broadcast(ctx.sessionId);
    return `Updated note ${id}.`;
  },
});

export function createBoardAgent(over: Partial<CreateLlmAgentOptions> = {}) {
  const llm = createLlmAgent({
    config,
    systemPrompt,
    tools: [listNotes, addNote, updateNote],
    providers: [openai],
    ...over,
  });
  return {
    ...llm,
    onDataChannelMessage(
      ctx: Parameters<NonNullable<typeof llm.onDataChannelMessage>>[0],
    ) {
      const m = parseBoardMessage(ctx.message);
      if (m) {
        apply(ctx.sessionId, m);
        return;
      }
      return llm.onDataChannelMessage?.(ctx);
    },
    onSessionEnd(ctx: { sessionId: string }) {
      boards.delete(ctx.sessionId);
      return llm.onSessionEnd?.(ctx);
    },
  };
}

defineAgent(createBoardAgent());
