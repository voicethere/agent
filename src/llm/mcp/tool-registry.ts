import type { LlmToolSpec } from "../types.js";
import type { McpLogFn, McpToolSource } from "./mcp-tool-source.js";
import { createRedactor } from "../agent/redact.js";
import type { ToolCallLogMode } from "../agent/redact.js";
import { buildToolCallFields } from "../agent/tool-call-log.js";
import type { ToolCallFields } from "../agent/tool-call-log.js";

export const MAX_TOOLS = 128;
export const MAX_RESULT_BYTES = 16_384;

const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export interface ToolCallContext {
  signal?: AbortSignal;
  timeoutMs: number;
  sessionId: string;
  /** Turn and model tool-call id, carried into the `llm.tool.call` log line. */
  turnId?: string;
  callId?: string;
}

export interface ToolCallLogOptions {
  mode: ToolCallLogMode;
  /** Values (env/project secrets) removed from every logged input and output. */
  secretValues: string[];
  emit: (fields: ToolCallFields) => void;
  now?: () => number;
}

export interface CustomTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(args: unknown, ctx: ToolCallContext): Promise<string>;
}

export interface ToolCallResult {
  content: string;
  isError: boolean;
}

export interface RegisteredTool {
  spec: LlmToolSpec;
  owner: "custom" | string;
}

interface Entry extends RegisteredTool {
  custom?: CustomTool;
  source?: McpToolSource;
  mcpName?: string;
}

export class ToolNameConflictError extends Error {
  readonly code = "LLM_TOOL_NAME_CONFLICT";
  constructor(name: string) {
    super(`custom tool ${name} is already registered`);
    this.name = "ToolNameConflictError";
  }
}

function sanitize(name: string): string {
  if (NAME_RE.test(name)) return name;
  const out = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return out.length > 0 ? out : "_";
}

function truncateResult(text: string): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= MAX_RESULT_BYTES) return text;
  let end = MAX_RESULT_BYTES;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return `${buf.subarray(0, end).toString("utf8")}\n[truncated]`;
}

export class ToolRegistry {
  private readonly custom: CustomTool[] = [];
  private readonly sources: McpToolSource[] = [];
  private readonly log: McpLogFn;
  private readonly warned = new Set<string>();

  private readonly toolCallLog: ToolCallLogOptions | undefined;
  private readonly redactor: ReturnType<typeof createRedactor> | undefined;

  constructor(opts: { log?: McpLogFn; toolCallLog?: ToolCallLogOptions } = {}) {
    this.log = opts.log ?? (() => {});
    const tcl = opts.toolCallLog;
    if (tcl && tcl.mode !== "off") {
      this.toolCallLog = tcl;
      this.redactor = createRedactor({
        secretValues: tcl.secretValues,
        mode: tcl.mode,
      });
    }
  }

  addCustomTool(tool: CustomTool): void {
    if (this.custom.some((t) => t.name === tool.name)) {
      throw new ToolNameConflictError(tool.name);
    }
    this.custom.push(tool);
  }

  addSource(source: McpToolSource): void {
    this.sources.push(source);
  }

  list(): RegisteredTool[] {
    return this.build().map(({ spec, owner }) => ({ spec, owner }));
  }

  async call(
    exposedName: string,
    args: unknown,
    opts: ToolCallContext,
  ): Promise<ToolCallResult> {
    const entry = this.build().find((e) => e.spec.name === exposedName);
    if (!entry) {
      return { isError: true, content: `tool ${exposedName} is not available` };
    }
    const clock = this.toolCallLog?.now ?? Date.now;
    const startedAt = clock();
    let result: ToolCallResult;
    try {
      if (entry.custom) {
        result = await this.callCustom(entry.custom, args, opts);
      } else {
        result = await entry.source!.callTool(entry.mcpName!, args, {
          signal: opts.signal,
          timeoutMs: opts.timeoutMs,
        });
      }
    } catch (err) {
      this.logToolCall(entry, exposedName, args, opts, startedAt, clock(), {
        isError: true,
        content: err instanceof Error ? err.message : "tool failed",
      });
      throw err;
    }
    this.logToolCall(
      entry,
      exposedName,
      args,
      opts,
      startedAt,
      clock(),
      result,
    );
    return { isError: result.isError, content: truncateResult(result.content) };
  }

  /** One `llm.tool.call` line per call; never throws into the call path. */
  private logToolCall(
    entry: Entry,
    exposedName: string,
    args: unknown,
    opts: ToolCallContext,
    startedAt: number,
    endedAt: number,
    result: ToolCallResult,
  ): void {
    const cfg = this.toolCallLog;
    const redactor = this.redactor;
    if (!cfg || !redactor || cfg.mode === "off") return;
    try {
      cfg.emit(
        buildToolCallFields({
          turnId: opts.turnId ?? "",
          callId: opts.callId ?? "",
          tool: exposedName,
          source: entry.custom ? "custom" : entry.owner,
          kind: entry.custom ? "custom" : (entry.source?.kind ?? "mcp"),
          startedAt,
          endedAt,
          input: redactor.redact(args),
          output: redactor.redact(result.content),
          isError: result.isError,
          mode: cfg.mode,
        }),
      );
    } catch (err) {
      this.log("warn", "tool call log failed", {
        tool: exposedName,
        error: err instanceof Error ? err.name : "error",
      });
    }
  }

  private async callCustom(
    tool: CustomTool,
    args: unknown,
    opts: ToolCallContext,
  ): Promise<ToolCallResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const content = await Promise.race([
        tool.handler(args, opts),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`tool ${tool.name} failed: timeout`)),
            opts.timeoutMs,
          );
        }),
      ]);
      return { isError: false, content: String(content) };
    } catch (err) {
      return {
        isError: true,
        content: err instanceof Error ? err.message : "tool failed",
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private warnOnce(
    key: string,
    message: string,
    fields: Record<string, unknown>,
  ): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log("warn", message, fields);
  }

  private build(): Entry[] {
    const entries: Entry[] = [];
    const used = new Set<string>();
    let capped = false;
    const push = (e: Entry): boolean => {
      if (entries.length >= MAX_TOOLS) {
        if (!capped) {
          capped = true;
          this.warnOnce("cap", "tool cap exceeded, dropping the rest", {
            max: MAX_TOOLS,
          });
        }
        return false;
      }
      used.add(e.spec.name);
      entries.push(e);
      return true;
    };
    for (const t of this.custom) {
      push({
        spec: {
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        },
        owner: "custom",
        custom: t,
      });
    }
    // Custom names are reserved before any MCP name is placed.
    const reserved = new Set(this.custom.map((t) => t.name));
    for (const source of this.sources) {
      for (const t of source.tools()) {
        let name = sanitize(t.name);
        if (used.has(name) || reserved.has(name)) {
          name = sanitize(`${source.name}__${t.name}`);
          if (used.has(name) || reserved.has(name)) {
            this.warnOnce(
              `clash:${source.name}:${t.name}`,
              "mcp tool name clash, skipping",
              { source: source.name, tool: t.name },
            );
            continue;
          }
        }
        push({
          spec: {
            name,
            description: t.description,
            inputSchema: t.inputSchema,
          },
          owner: source.name,
          source,
          mcpName: t.name,
        });
      }
    }
    return entries;
  }
}
