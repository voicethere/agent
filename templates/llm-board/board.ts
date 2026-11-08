export const NOTE_COLORS = ["yellow", "blue", "green", "pink"] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];

export const MAX_NOTES = 60;
export const MAX_NOTE_TEXT = 200;

export type Note = {
  id: string;
  /** 1 to 200 characters. */
  text: string;
  /** 0 to 1, left to right. */
  x: number;
  /** 0 to 1, top to bottom. */
  y: number;
  color: NoteColor;
  author: "user" | "ai";
};

export type NotePatch = {
  text?: string;
  x?: number;
  y?: number;
  color?: NoteColor;
};

export type AddInput = {
  text: string;
  x?: number;
  y?: number;
  color?: NoteColor;
  author: "user" | "ai";
};

/** Client to agent messages. Anything else is not a board message. */
export type BoardMessage =
  | {
      type: "note.add";
      text: string;
      x?: number;
      y?: number;
      color?: NoteColor;
    }
  | {
      type: "note.update";
      id: string;
      text?: string;
      x?: number;
      y?: number;
      color?: NoteColor;
    }
  | { type: "note.remove"; id: string }
  | { type: "board.sync" };

export type BoardResult<T> =
  { ok: true; value: T } | { ok: false; error: string };

function validText(v: unknown): v is string {
  return typeof v === "string" && v.length >= 1 && v.length <= MAX_NOTE_TEXT;
}

function unit(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

function color(v: unknown): v is NoteColor {
  return (
    typeof v === "string" && (NOTE_COLORS as readonly string[]).includes(v)
  );
}

/** A free spot on a 6 by 5 grid: the first cell no note sits on, else the first cell. */
export function freeSlot(notes: readonly Note[]): { x: number; y: number } {
  const cols = 6;
  const rows = 5;
  for (let i = 0; i < cols * rows; i++) {
    const x = (i % cols) / cols + 0.04;
    const y = Math.floor(i / cols) / rows + 0.04;
    const taken = notes.some(
      (n) => Math.abs(n.x - x) < 0.01 && Math.abs(n.y - y) < 0.01,
    );
    if (!taken) return { x, y };
  }
  return { x: 0.04, y: 0.04 };
}

export class Board {
  private notes = new Map<string, Note>();
  private seq = 0;

  add(input: AddInput): BoardResult<Note> {
    if (!validText(input.text)) {
      return {
        ok: false,
        error: `note text must be 1 to ${MAX_NOTE_TEXT} characters`,
      };
    }
    if (this.notes.size >= MAX_NOTES)
      return { ok: false, error: "board is full" };
    if (input.x !== undefined && !unit(input.x))
      return { ok: false, error: "x must be between 0 and 1" };
    if (input.y !== undefined && !unit(input.y))
      return { ok: false, error: "y must be between 0 and 1" };
    if (input.color !== undefined && !color(input.color))
      return { ok: false, error: "unknown color" };
    const slot = freeSlot(this.list());
    this.seq += 1;
    const note: Note = {
      id: `n${this.seq}`,
      text: input.text,
      x: input.x ?? slot.x,
      y: input.y ?? slot.y,
      color: input.color ?? "yellow",
      author: input.author,
    };
    this.notes.set(note.id, note);
    return { ok: true, value: note };
  }

  update(id: string, patch: NotePatch): BoardResult<Note> {
    const note = this.notes.get(id);
    if (!note) return { ok: false, error: `No note with id ${id}.` };
    if (patch.text !== undefined && !validText(patch.text)) {
      return {
        ok: false,
        error: `note text must be 1 to ${MAX_NOTE_TEXT} characters`,
      };
    }
    if (patch.x !== undefined && !unit(patch.x))
      return { ok: false, error: "x must be between 0 and 1" };
    if (patch.y !== undefined && !unit(patch.y))
      return { ok: false, error: "y must be between 0 and 1" };
    if (patch.color !== undefined && !color(patch.color))
      return { ok: false, error: "unknown color" };
    const next: Note = {
      ...note,
      ...(patch.text !== undefined ? { text: patch.text } : {}),
      ...(patch.x !== undefined ? { x: patch.x } : {}),
      ...(patch.y !== undefined ? { y: patch.y } : {}),
      ...(patch.color !== undefined ? { color: patch.color } : {}),
    };
    this.notes.set(id, next);
    return { ok: true, value: next };
  }

  remove(id: string): boolean {
    return this.notes.delete(id);
  }

  list(): Note[] {
    return [...this.notes.values()];
  }
}

export function parseBoardMessage(msg: unknown): BoardMessage | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  switch (m.type) {
    case "board.sync":
      return { type: "board.sync" };
    case "note.remove":
      return typeof m.id === "string" && m.id
        ? { type: "note.remove", id: m.id }
        : null;
    case "note.add": {
      if (typeof m.text !== "string") return null;
      return {
        type: "note.add",
        text: m.text,
        ...(m.x !== undefined ? { x: m.x as number } : {}),
        ...(m.y !== undefined ? { y: m.y as number } : {}),
        ...(m.color !== undefined ? { color: m.color as NoteColor } : {}),
      };
    }
    case "note.update": {
      if (typeof m.id !== "string" || !m.id) return null;
      return {
        type: "note.update",
        id: m.id,
        ...(m.text !== undefined ? { text: m.text as string } : {}),
        ...(m.x !== undefined ? { x: m.x as number } : {}),
        ...(m.y !== undefined ? { y: m.y as number } : {}),
        ...(m.color !== undefined ? { color: m.color as NoteColor } : {}),
      };
    }
    default:
      return null;
  }
}
