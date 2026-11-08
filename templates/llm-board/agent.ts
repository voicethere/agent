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

// Boards are room-scoped. A client joins a room with { type: "board.join",
// room }; every session in the room sees the same board. A session that never
// joins has a private room of its own ("s:" + sessionId; clients cannot name
// it because room ids match /^[a-z0-9-]{6,40}$/). One agent process serves
// many sessions, so a single process-wide board would show visitors each
// other's notes. A room's board is deleted when its last session leaves.
const boards = new Map<string, Board>();
const roomOf = new Map<string, string>();
const members = new Map<string, Set<string>>();

function roomFor(sessionId: string): string {
  let room = roomOf.get(sessionId);
  if (!room) {
    room = `s:${sessionId}`;
    enter(sessionId, room);
  }
  return room;
}

function enter(sessionId: string, room: string): void {
  roomOf.set(sessionId, room);
  let set = members.get(room);
  if (!set) {
    set = new Set();
    members.set(room, set);
  }
  set.add(sessionId);
}

function leave(sessionId: string): void {
  const room = roomOf.get(sessionId);
  if (!room) return;
  roomOf.delete(sessionId);
  const set = members.get(room);
  set?.delete(sessionId);
  if (!set || set.size === 0) {
    members.delete(room);
    boards.delete(room);
  }
}

function boardFor(sessionId: string): Board {
  const room = roomFor(sessionId);
  let board = boards.get(room);
  if (!board) {
    board = new Board();
    boards.set(room, board);
  }
  return board;
}

/** Sends the room's board to every session in it. */
function broadcast(sessionId: string): void {
  const room = roomFor(sessionId);
  const payload = { type: "board", notes: boardFor(sessionId).list() };
  for (const member of members.get(room) ?? []) {
    sendToClient(member, payload);
  }
}

function apply(sessionId: string, m: BoardMessage): void {
  switch (m.type) {
    case "board.join": {
      if (roomOf.get(sessionId) !== m.room) {
        leave(sessionId);
        enter(sessionId, m.room);
      }
      break;
    }
    case "note.add":
      boardFor(sessionId).add({ ...m, author: "user" });
      break;
    case "note.update": {
      const { type: _type, id, ...patch } = m;
      boardFor(sessionId).update(id, patch);
      break;
    }
    case "note.remove":
      boardFor(sessionId).remove(m.id);
      break;
    case "board.sync":
      // Only the requester gets the board.
      sendToClient(sessionId, {
        type: "board",
        notes: boardFor(sessionId).list(),
      });
      return;
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
      leave(ctx.sessionId);
      return llm.onSessionEnd?.(ctx);
    },
  };
}

defineAgent(createBoardAgent());
