import { AGENT_LOG_FIELDS_MAX_CHARS } from "../../runtime.js";

export const TOOL_CALL_EVENT = "llm.tool.call";

const MAX_PART_CHARS = 2048;
const MAX_FIELDS_CHARS = AGENT_LOG_FIELDS_MAX_CHARS - 192;

export type ToolCallKind = "mcp" | "service" | "custom";

export interface ToolCallFields {
  event: typeof TOOL_CALL_EVENT;
  turnId: string;
  callId: string;
  tool: string;
  source: string;
  kind: ToolCallKind;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  isError: boolean;
  input: string;
  output: string;
  redaction: "full" | "redacted";
  truncated: ("input" | "output")[];
}

function cutCodePoints(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join("");
}

function serialize(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[unserializable]";
  }
}

/**
 * One log line per tool call. `input` and `output` must already be redacted.
 * Each is cut to 2048 characters; the whole fields object stays under the agent
 * log cap (output shrinks first, then input).
 */
export function buildToolCallFields(a: {
  turnId: string;
  callId: string;
  tool: string;
  source: string;
  kind: ToolCallKind;
  startedAt: number;
  endedAt: number;
  input: unknown;
  output: unknown;
  isError: boolean;
  mode: "full" | "redacted";
}): ToolCallFields {
  // Strictly later than the start, so tool rows sort after the row they follow.
  const endMs = Math.max(a.endedAt, a.startedAt + 1);
  const truncated = new Set<"input" | "output">();
  let input = serialize(a.input);
  let output = serialize(a.output);
  if (Array.from(input).length > MAX_PART_CHARS) {
    input = cutCodePoints(input, MAX_PART_CHARS);
    truncated.add("input");
  }
  if (Array.from(output).length > MAX_PART_CHARS) {
    output = cutCodePoints(output, MAX_PART_CHARS);
    truncated.add("output");
  }
  const build = (): ToolCallFields => ({
    event: TOOL_CALL_EVENT,
    turnId: a.turnId,
    callId: a.callId,
    tool: a.tool,
    source: a.source,
    kind: a.kind,
    startedAt: new Date(a.startedAt).toISOString(),
    endedAt: new Date(endMs).toISOString(),
    durationMs: endMs - a.startedAt,
    isError: a.isError,
    input,
    output,
    redaction: a.mode,
    truncated: [...truncated],
  });
  let fields = build();
  // JSON escaping can grow the text; shrink output first, then input.
  for (const part of ["output", "input"] as const) {
    while (JSON.stringify(fields).length > MAX_FIELDS_CHARS) {
      const cur = part === "output" ? output : input;
      if (cur.length === 0) break;
      const next = cutCodePoints(cur, Math.floor(Array.from(cur).length / 2));
      if (part === "output") output = next;
      else input = next;
      truncated.add(part);
      fields = build();
    }
  }
  return fields;
}
