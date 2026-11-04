import type { FlowModel } from "./types.js";

export interface FlowHttpRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  /** A string is sent as is; `{secret}` is resolved by the effect layer from the environment. */
  headers: Record<string, string | { secret: string; prefix: string }>;
  body?: unknown;
  timeoutMs: number;
}

export interface FlowHttpResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

export interface FlowLlmCall {
  model: FlowModel;
  system: string;
  messages: { role: "user" | "assistant"; text: string }[];
  /** Tool names offered, or "all" / "none". */
  tools: "none" | "all" | string[];
  speak: boolean;
  maxRounds?: number;
  timeoutMs?: number;
  /** Said once, marked as filler, when no sentence has arrived after `afterMs`. */
  filler?: { text: string; afterMs: number };
}

export type FlowLlmEvent =
  | { type: "sentence"; text: string; filler?: boolean }
  | {
      type: "tool";
      name: string;
      phase: "start" | "end";
      durationMs?: number;
      error?: string;
    }
  | {
      type: "done";
      text: string;
      tokens?: { input?: number; output?: number };
    };

export interface FlowClassifyCall {
  model: FlowModel;
  input: string;
  paths: { id: string; examples: string[] }[];
  history?: { role: "user" | "assistant"; text: string }[];
  timeoutMs: number;
}

export interface FlowSpeakHandle {
  done: Promise<{ status: string }>;
  cancel(): void;
}

export interface FlowEffects {
  speak(
    text: string,
    o: { interruptible: boolean; turnId: string; filler?: boolean },
  ): FlowSpeakHandle;
  /** A chat-channel reply. `turnId` is the turn's id; the runner stores it on each agent row it writes for this reply. */
  chat?(text: string, o?: { turnId?: string }): FlowSpeakHandle | void;
  /**
   * Awaited before each node is entered; the node runs only after the promise
   * resolves. Used by step debuggers. Absent = no await. A rejection ends the
   * session through the effect-failure path.
   */
  beforeNode?(nodeId: string): Promise<void>;
  http(req: FlowHttpRequest, signal: AbortSignal): Promise<FlowHttpResponse>;
  tool(
    source: string,
    tool: string,
    args: unknown,
    signal: AbortSignal,
    opts?: { timeoutMs?: number },
  ): Promise<{ content: string; isError?: boolean }>;
  llm(req: FlowLlmCall, signal: AbortSignal): AsyncIterable<FlowLlmEvent>;
  classify(
    req: FlowClassifyCall,
    signal: AbortSignal,
  ): Promise<{ path: string; tokens?: { input?: number; output?: number } }>;
  end(reason: string): void;
  /** Metadata-only log line (ids, lengths, codes; never customer content). */
  log?(
    level: "info" | "warn",
    message: string,
    fields: Record<string, unknown>,
  ): void;
  trace(e: import("./trace.js").FlowTraceEvent): void;
  clock: {
    now(): number;
    /** Returns a cancel function. */
    setTimeout(fn: () => void, ms: number): () => void;
  };
}
