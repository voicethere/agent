import { NOTE_COLORS } from "./board.js";

const colorSchema = { type: "string", enum: [...NOTE_COLORS] };

export const BOARD_TOOL_SPECS = {
  list_notes: {
    name: "list_notes",
    description: "List every note on the shared board.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  add_note: {
    name: "add_note",
    description:
      "Add a new note to the shared board. Only for a note that is not on the board yet; to rename, reword, recolor or move an existing note use update_note. Text is 1 to 200 characters.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" }, color: colorSchema },
      required: ["text"],
      additionalProperties: false,
    },
  },
  update_note: {
    name: "update_note",
    description:
      "Change an existing note by id: its text (also to rename or reword it), color or position (x and y between 0 and 1). Get the id from list_notes.",
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
  },
} as const;
