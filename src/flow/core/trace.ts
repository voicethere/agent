import type { FlowNodeType } from "./types.js";

export interface FlowTraceEvent {
  seq: number;
  stepSeq: number;
  nodeId: string;
  type: FlowNodeType;
  phase: "enter" | "exit";
  /** Taken target node id or path id. */
  edge?: string;
  via?: "rule" | "classifier" | "mock";
  durationMs?: number;
  /** Names only. */
  varsChanged?: string[];
  /** Present only with includeValuesInTrace. */
  vars?: Record<string, unknown>;
  error?: string;
  /** seq of the parent event (tool calls inside an llm node). */
  parent?: number;
  tool?: string;
  /** Token counts of a classifier or llm call. Counts only. */
  tokens?: { input?: number; output?: number };
}
