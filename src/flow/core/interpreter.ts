import { renderValue } from "./compile.js";
import type { CompiledFlow, CompiledNode } from "./compile.js";
import type {
  FlowEffects,
  FlowHttpRequest,
  FlowSpeakHandle,
} from "./effects.js";
import { resolvePointer } from "./json-pointer.js";
import { matchRule } from "./route.js";
import { renderTemplate, type TemplatePart } from "./template.js";
import type { FlowTraceEvent } from "./trace.js";

export interface FlowSessionOptions {
  sessionId: string;
  channel: "voice" | "chat";
  initialVars?: Record<string, unknown>;
  includeValuesInTrace?: boolean;
  maxStepsPerTurn?: number;
}

export interface UserInputOptions {
  utteranceId?: string;
  language?: string;
  /** Where the caller typed or spoke; replies follow it. Default: unchanged. */
  source?: "voice" | "chat";
}

/** Backstop for a whole llm node (all rounds and tool calls). */
export const LLM_NODE_TIMEOUT_MS = 120_000;

type Bounded<T> =
  | { k: "ok"; v: T }
  | { k: "timeout" }
  | { k: "err"; err: unknown }
  | { k: "cancelled" };

interface UserInput extends UserInputOptions {
  text: string;
}

interface Waiting {
  index: number;
  seq: number;
  cancelTimer: () => void;
  enterAt: number;
  eventSeq: number;
}

export class FlowSession {
  private readonly compiled: CompiledFlow;
  private readonly fx: FlowEffects;
  private readonly opts: FlowSessionOptions;
  private readonly maxSteps: number;

  private vars: Record<string, unknown> = {};
  private history: { role: "user" | "assistant"; text: string }[] = [];
  private nodeIndex: number;
  private channel: "voice" | "chat";
  private pendingFinal: UserInput | undefined;
  private stepSeq = 0;
  private traceSeq = 0;
  private stepsThisTurn = 0;
  private turnStartSeq = 0;
  private waiting: Waiting | undefined;
  private cancelCurrent: (() => void) | undefined;
  private running = false;
  private again = false;
  private started = false;
  private _ended = false;
  private _staleDropped = 0;

  constructor(
    compiled: CompiledFlow,
    effects: FlowEffects,
    opts: FlowSessionOptions,
  ) {
    this.compiled = compiled;
    this.fx = effects;
    this.opts = opts;
    this.maxSteps = opts.maxStepsPerTurn ?? 100;
    this.channel = opts.channel;
    this.nodeIndex = compiled.start;
    this.vars = Object.assign(
      Object.create(null) as Record<string, unknown>,
      compiled.defaults,
      opts.initialVars ?? {},
      { "session.id": opts.sessionId, "session.channel": opts.channel },
    );
  }

  get ended(): boolean {
    return this._ended;
  }

  get staleDropped(): number {
    return this._staleDropped;
  }

  get variables(): Record<string, unknown> {
    return { ...this.vars };
  }

  /** Prototype of the internal variable store (null). */
  get variablesPrototype(): object | null {
    return Object.getPrototypeOf(this.vars);
  }

  get conversation(): { role: "user" | "assistant"; text: string }[] {
    return this.history.map((h) => ({ ...h }));
  }

  start(): Promise<void> {
    if (this.started || this._ended) return Promise.resolve();
    this.started = true;
    return this.drive();
  }

  onUserText(text: string, o: UserInputOptions = {}): Promise<void> {
    if (this._ended || !this.started) return Promise.resolve();
    const w = this.waiting;
    if (w) {
      this.resumeListen(w, "input", { text, ...o });
      return this.drive();
    }
    // Metadata only: no text.
    this.fx.log?.("info", "flow_input_buffered", {
      length: text.length,
      ...(o.utteranceId !== undefined ? { utteranceId: o.utteranceId } : {}),
      replaced: this.pendingFinal !== undefined,
    });
    this.pendingFinal = { text, ...o };
    return Promise.resolve();
  }

  stop(): void {
    if (this._ended) return;
    this._ended = true;
    this.stepSeq++;
    this.waiting?.cancelTimer();
    this.waiting = undefined;
    this.cancelCurrent?.();
    this.cancelCurrent = undefined;
  }

  // ---- internals ----

  private lookup = (path: string): unknown => {
    if (Object.hasOwn(this.vars, path)) return this.vars[path];
    const parts = path.split(".");
    for (let k = parts.length - 1; k >= 1; k--) {
      const head = parts.slice(0, k).join(".");
      if (Object.hasOwn(this.vars, head)) {
        let cur: unknown = this.vars[head];
        for (const key of parts.slice(k)) {
          if (cur === null || typeof cur !== "object") return undefined;
          cur = Object.hasOwn(cur, key)
            ? (cur as Record<string, unknown>)[key]
            : undefined;
        }
        return cur;
      }
    }
    return undefined;
  };

  private render(parts: TemplatePart[]): string {
    return renderTemplate(parts, this.lookup);
  }

  private emit(
    node: CompiledNode,
    phase: "enter" | "exit",
    extra: Partial<FlowTraceEvent> = {},
  ): number {
    const seq = ++this.traceSeq;
    const e: FlowTraceEvent = {
      seq,
      stepSeq: this.stepSeq,
      nodeId: node.id,
      type: node.type,
      phase,
      ...extra,
    };
    if (phase === "exit" && this.opts.includeValuesInTrace)
      e.vars = { ...this.vars };
    this.fx.trace(e);
    return seq;
  }

  private async drive(): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        try {
          await this.loop();
        } catch {
          this.failEffect();
          return;
        }
      } while (this.again && !this._ended);
    } finally {
      this.running = false;
    }
  }

  private failEffect(): void {
    this.cancelCurrent?.();
    this.cancelCurrent = undefined;
    if (this._ended) return;
    this._ended = true;
    this.waiting?.cancelTimer();
    this.waiting = undefined;
    try {
      const node = this.compiled.nodes[this.nodeIndex]!;
      this.emit(node, "exit", { error: "FLOW_EFFECT_ERROR" });
      this.fx.end("error");
    } catch {
      // reporting must not throw out of the drive loop
    }
  }

  private nameOf(i: number): string {
    return this.compiled.nodes[i]!.id;
  }

  private get turnId(): string {
    return `${this.opts.sessionId}:${this.turnStartSeq}`;
  }

  private resumeListen(
    w: Waiting,
    how: "input" | "timeout",
    input?: UserInput,
  ): void {
    const node = this.compiled.nodes[w.index]!;
    if (node.type !== "listen") return;
    w.cancelTimer();
    this.waiting = undefined;
    const changed: string[] = [];
    let target: number;
    if (how === "input" && input) {
      this.applyInput(input, changed);
      target = node.next;
    } else {
      target = node.onNoInput;
    }
    this.stepsThisTurn = 0;
    this.turnStartSeq = this.stepSeq;
    this.emit(node, "exit", {
      edge: this.nameOf(target),
      durationMs: this.fx.clock.now() - w.enterAt,
      varsChanged: changed,
    });
    this.nodeIndex = target;
  }

  private applyInput(input: UserInput, changed: string[]): void {
    if (input.source !== undefined && input.source !== this.channel) {
      this.channel = input.source;
      this.vars["session.channel"] = input.source;
      changed.push("session.channel");
    }
    this.vars["last.transcript"] = input.text;
    changed.push("last.transcript");
    if (input.utteranceId !== undefined) {
      this.vars["last.utteranceId"] = input.utteranceId;
      changed.push("last.utteranceId");
    }
    if (input.language !== undefined) {
      this.vars["last.language"] = input.language;
      changed.push("last.language");
    } else if (Object.hasOwn(this.vars, "last.language")) {
      delete this.vars["last.language"];
      changed.push("last.language");
    }
    this.history.push({ role: "user", text: input.text });
  }

  private setError(id: string, code: string, changed: string[]): void {
    this.vars[`error.${id}`] = code;
    changed.push(`error.${id}`);
  }

  private clearError(id: string, changed: string[]): void {
    if (Object.hasOwn(this.vars, `error.${id}`)) {
      delete this.vars[`error.${id}`];
      changed.push(`error.${id}`);
    }
  }

  private applyMap(
    map: [string, string][],
    body: unknown,
    changed: string[],
  ): void {
    for (const [name, pointer] of map) {
      const v = resolvePointer(body, pointer);
      if (v === undefined) continue;
      this.vars[name] = v;
      changed.push(name);
    }
  }

  /** Runs one effect call with a timeout; `cancelCurrent` cancels it. */
  private async bounded<T>(
    timeoutMs: number,
    start: (signal: AbortSignal) => Promise<T>,
  ): Promise<Bounded<T>> {
    const ctl = new AbortController();
    let cancelTimer: () => void = () => {};
    const out = await new Promise<Bounded<T>>((resolve) => {
      cancelTimer = this.fx.clock.setTimeout(() => {
        ctl.abort();
        resolve({ k: "timeout" });
      }, timeoutMs);
      this.cancelCurrent = () => {
        cancelTimer();
        ctl.abort();
        resolve({ k: "cancelled" });
      };
      let p: Promise<T>;
      try {
        p = start(ctl.signal);
      } catch (err) {
        resolve({ k: "err", err });
        return;
      }
      p.then(
        (v) => resolve({ k: "ok", v }),
        (err) => resolve({ k: "err", err }),
      );
    });
    cancelTimer();
    this.cancelCurrent = undefined;
    return out;
  }

  private stale(seq: number): boolean {
    if (this._ended || seq !== this.stepSeq) {
      this._staleDropped++;
      return true;
    }
    return false;
  }

  private async loop(): Promise<void> {
    while (!this._ended) {
      if (this.waiting) return;
      if (this.stepsThisTurn >= this.maxSteps) {
        const node = this.compiled.nodes[this.nodeIndex]!;
        this.stepSeq++;
        this.emit(node, "exit", { error: "FLOW_STEP_LIMIT" });
        this._ended = true;
        this.fx.end("step_limit");
        return;
      }
      const index = this.nodeIndex;
      const node = this.compiled.nodes[index]!;
      const seq = ++this.stepSeq;
      this.stepsThisTurn++;
      const t0 = this.fx.clock.now();
      const enterSeq = this.emit(node, "enter");
      const done = (
        target: number | undefined,
        extra: Partial<FlowTraceEvent> = {},
      ): void => {
        this.emit(node, "exit", {
          durationMs: this.fx.clock.now() - t0,
          ...(target !== undefined ? { edge: this.nameOf(target) } : {}),
          ...extra,
        });
        if (target !== undefined) this.nodeIndex = target;
      };

      switch (node.type) {
        case "speak": {
          const text = this.render(node.text);
          this.history.push({ role: "assistant", text });
          if (this.channel === "chat") {
            this.fx.chat?.(text);
          } else {
            const h = this.fx.speak(text, {
              interruptible: node.interruptible,
              turnId: this.turnId,
            });
            this.cancelCurrent = h.cancel;
            await h.done;
            this.cancelCurrent = undefined;
            if (this.stale(seq)) return;
          }
          done(node.next);
          break;
        }
        case "listen": {
          if (this.pendingFinal) {
            const p = this.pendingFinal;
            this.pendingFinal = undefined;
            const changed: string[] = [];
            this.applyInput(p, changed);
            this.stepsThisTurn = 0;
            this.turnStartSeq = this.stepSeq;
            done(node.next, { varsChanged: changed });
            break;
          }
          const cancelTimer = this.fx.clock.setTimeout(() => {
            const w = this.waiting;
            if (!w || w.seq !== seq || this._ended) return;
            try {
              this.resumeListen(w, "timeout");
            } catch {
              this.failEffect();
              return;
            }
            void this.drive();
          }, node.timeoutMs);
          this.waiting = {
            index,
            seq,
            cancelTimer,
            enterAt: t0,
            eventSeq: enterSeq,
          };
          return;
        }
        case "wait": {
          let cancel: () => void = () => {};
          await new Promise<void>((resolve) => {
            cancel = this.fx.clock.setTimeout(resolve, node.ms);
            this.cancelCurrent = () => {
              cancel();
              resolve();
            };
          });
          this.cancelCurrent = undefined;
          if (this.stale(seq)) return;
          this.stepsThisTurn = 0;
          done(node.next);
          break;
        }
        case "set": {
          const changed: string[] = [];
          for (const a of node.assign) {
            this.vars[a.name] =
              typeof a.value === "object" ? this.render(a.value) : a.value;
            changed.push(a.name);
          }
          done(node.next, { varsChanged: changed });
          break;
        }
        case "condition": {
          done(node.test(this.lookup) ? node.then : node.else);
          break;
        }
        case "end": {
          if (node.text) {
            const text = this.render(node.text);
            this.history.push({ role: "assistant", text });
            if (this.channel === "chat") {
              this.fx.chat?.(text);
            } else {
              const h = this.fx.speak(text, {
                interruptible: false,
                turnId: this.turnId,
              });
              this.cancelCurrent = h.cancel;
              await h.done;
              this.cancelCurrent = undefined;
              if (this.stale(seq)) return;
            }
          }
          done(undefined);
          this._ended = true;
          this.fx.end(node.reason);
          return;
        }
        case "route": {
          const text = this.render(node.input);
          const rule = matchRule(node.paths, text);
          let chosen = rule.path;
          let via: "rule" | "classifier" = "rule";
          let errCode: string | undefined;
          let tokens: { input?: number; output?: number } | undefined;
          if (!chosen) {
            via = "classifier";
            const model =
              this.compiled.models[node.model ?? "classifier"] ??
              this.compiled.models["default"];
            const ctl = new AbortController();
            let cancelTimer: () => void = () => {};
            const outcome = await new Promise<
              | { k: "ok"; path: string; tokens?: typeof tokens }
              | { k: "timeout" }
              | { k: "err"; code: string }
              | { k: "cancelled" }
            >((resolve) => {
              cancelTimer = this.fx.clock.setTimeout(() => {
                ctl.abort();
                resolve({ k: "timeout" });
              }, node.timeoutMs);
              this.cancelCurrent = () => {
                cancelTimer();
                ctl.abort();
                resolve({ k: "cancelled" });
              };
              let p: ReturnType<FlowEffects["classify"]>;
              try {
                p = this.fx.classify(
                  {
                    model: model!,
                    input: text,
                    paths: node.paths.map((x) => ({
                      id: x.id,
                      examples: x.examples,
                    })),
                    ...(node.historyTurns > 0
                      ? {
                          history: this.history
                            .slice(-node.historyTurns * 2)
                            .map((h) => ({ ...h })),
                        }
                      : {}),
                    timeoutMs: node.timeoutMs,
                  },
                  ctl.signal,
                );
              } catch (err) {
                resolve({ k: "err", code: errorCode(err) });
                return;
              }
              p.then(
                (r) => resolve({ k: "ok", path: r.path, tokens: r.tokens }),
                (err) => resolve({ k: "err", code: errorCode(err) }),
              );
            });
            cancelTimer();
            this.cancelCurrent = undefined;
            if (this.stale(seq)) return;
            if (outcome.k === "timeout") errCode = "ROUTE_TIMEOUT";
            else if (outcome.k === "err") errCode = outcome.code;
            else if (outcome.k === "ok") {
              chosen = node.paths.find((x) => x.id === outcome.path);
              tokens = outcome.tokens;
              // Only an explicit "none" goes to onNone; an id outside the
              // path list is a classifier failure.
              if (!chosen && outcome.path !== "none")
                errCode = "LLM_CLASSIFIER_NO_CALL";
            }
          }
          if (errCode !== undefined) {
            this.vars[`error.${node.id}`] = errCode;
            done(node.onError, {
              via,
              error: errCode,
              ...(tokens ? { tokens } : {}),
              varsChanged: [`error.${node.id}`],
            });
            break;
          }
          if (!chosen) {
            done(node.onNone, {
              via,
              edge: "none",
              ...(tokens ? { tokens } : {}),
            });
            break;
          }
          this.vars[`route.${node.id}`] = chosen.id;
          done(chosen.next, {
            edge: chosen.id,
            via,
            ...(tokens ? { tokens } : {}),
            varsChanged: [`route.${node.id}`],
          });
          break;
        }
        case "http": {
          const headers: FlowHttpRequest["headers"] = {};
          for (const [k, h] of node.headers) {
            headers[k] =
              h.kind === "secret"
                ? { secret: h.secret, prefix: h.prefix }
                : this.render(h.parts);
          }
          const req: FlowHttpRequest = {
            method: node.method,
            url: this.render(node.url),
            headers,
            ...(node.body !== undefined
              ? { body: renderValue(node.body, (p) => this.render(p)) }
              : {}),
            timeoutMs: node.timeoutMs,
          };
          const out = await this.bounded(node.timeoutMs, (sig) =>
            this.fx.http(req, sig),
          );
          if (this.stale(seq)) return;
          const changed: string[] = [];
          let code: string | undefined;
          if (out.k === "timeout") code = "HTTP_TIMEOUT";
          else if (out.k === "err") code = errorCode(out.err, "HTTP_NETWORK");
          else if (out.k === "ok") {
            const st = out.v.status;
            this.vars[`${node.id}.status`] = st;
            changed.push(`${node.id}.status`);
            if (st < 200 || st >= 300) code = `HTTP_${st}`;
            else this.applyMap(node.map, out.v.body, changed);
          }
          if (code !== undefined) {
            this.setError(node.id, code, changed);
            done(node.onError, { error: code, varsChanged: changed });
          } else {
            this.clearError(node.id, changed);
            done(node.next, { varsChanged: changed });
          }
          break;
        }
        case "mcp": {
          const args =
            node.args === undefined
              ? {}
              : renderValue(node.args, (p) => this.render(p));
          const out = await this.bounded(node.timeoutMs, (sig) =>
            this.fx.tool(node.source, node.tool, args, sig, {
              timeoutMs: node.timeoutMs,
            }),
          );
          if (this.stale(seq)) return;
          const changed: string[] = [];
          let code: string | undefined;
          if (out.k === "timeout") code = "MCP_TIMEOUT";
          else if (out.k === "err") code = errorCode(out.err, "MCP_ERROR");
          else if (out.k === "ok") {
            if (out.v.isError) code = "MCP_TOOL_ERROR";
            else {
              const parsed = parseJson(out.v.content);
              const structured =
                parsed !== null && typeof parsed === "object"
                  ? parsed
                  : undefined;
              if (node.map.length > 0)
                this.applyMap(node.map, structured ?? out.v.content, changed);
              else {
                this.vars[`${node.id}.result`] = structured ?? out.v.content;
                changed.push(`${node.id}.result`);
              }
            }
          }
          if (code !== undefined) {
            this.setError(node.id, code, changed);
            done(node.onError, { error: code, varsChanged: changed });
          } else {
            this.clearError(node.id, changed);
            done(node.next, { varsChanged: changed });
          }
          break;
        }
        case "llm": {
          const hist = this.history.map((h) => ({ ...h }));
          const messages =
            node.send === "message"
              ? [
                  {
                    role: "user" as const,
                    text: node.message ? this.render(node.message) : "",
                  },
                ]
              : node.historyTurns !== undefined
                ? hist.slice(-node.historyTurns)
                : hist;
          const ctl = new AbortController();
          const handles: FlowSpeakHandle[] = [];
          const spoken: string[] = [];
          let timedOut = false;
          let cancelled = false;
          let abortWake: () => void = () => {};
          const aborted = new Promise<"aborted">((resolve) => {
            abortWake = () => resolve("aborted");
          });
          const cancelTimer = this.fx.clock.setTimeout(() => {
            timedOut = true;
            ctl.abort();
            abortWake();
          }, LLM_NODE_TIMEOUT_MS);
          this.cancelCurrent = () => {
            cancelled = true;
            ctl.abort();
            abortWake();
            for (const h of handles) h.cancel();
          };
          let code: string | undefined;
          let finalText: string | undefined;
          let tokens: { input?: number; output?: number } | undefined;
          try {
            const iter = this.fx
              .llm(
                {
                  model: this.compiled.models[node.model ?? "default"]!,
                  system: this.render(node.instructions),
                  messages,
                  tools: node.tools,
                  speak: node.speak,
                  maxRounds: node.maxRounds,
                  ...(node.filler ? { filler: node.filler } : {}),
                },
                ctl.signal,
              )
              [Symbol.asyncIterator]();
            for (;;) {
              const r = await Promise.race([iter.next(), aborted]);
              if (cancelled || this._ended) {
                // stop() can win while a result is already resolved: act on nothing.
                void iter.return?.(undefined)?.catch?.(() => {});
                break;
              }
              if (r === "aborted") {
                void iter.return?.(undefined)?.catch?.(() => {});
                break;
              }
              if (r.done) break;
              const ev = r.value;
              if (ev.type === "sentence") {
                if (this.channel === "chat") {
                  // Chat gets one reply at the end of the node, not one per sentence.
                } else {
                  handles.push(
                    this.fx.speak(ev.text, {
                      interruptible: true,
                      turnId: this.turnId,
                      ...(ev.filler ? { filler: true } : {}),
                    }),
                  );
                }
                if (!ev.filler) spoken.push(ev.text);
              } else if (ev.type === "tool") {
                if (ev.phase === "start") {
                  this.emit(node, "enter", { parent: enterSeq, tool: ev.name });
                } else {
                  this.emit(node, "exit", {
                    parent: enterSeq,
                    tool: ev.name,
                    ...(ev.durationMs !== undefined
                      ? { durationMs: ev.durationMs }
                      : {}),
                    ...(ev.error ? { error: ev.error } : {}),
                  });
                }
              } else {
                finalText = ev.text;
                tokens = ev.tokens;
              }
            }
            if (timedOut) code = "LLM_TIMEOUT";
            else if (!cancelled && finalText === undefined)
              code = "LLM_NO_RESULT";
          } catch (err) {
            code = timedOut ? "LLM_TIMEOUT" : errorCode(err, "LLM_ERROR");
          }
          cancelTimer();
          this.cancelCurrent = undefined;
          if (cancelled || this.stale(seq)) return;
          if (this.channel === "chat" && spoken.length > 0)
            this.fx.chat?.(spoken.join(" "));
          if (handles.length > 0) {
            this.cancelCurrent = () => {
              for (const h of handles) h.cancel();
            };
            await Promise.all(handles.map((h) => h.done.catch(() => {})));
            this.cancelCurrent = undefined;
            if (this.stale(seq)) return;
          }
          const changed: string[] = [];
          if (spoken.length > 0)
            this.history.push({ role: "assistant", text: spoken.join(" ") });
          if (code !== undefined) {
            this.setError(node.id, code, changed);
            done(node.onError, {
              error: code,
              varsChanged: changed,
              ...(tokens ? { tokens } : {}),
            });
          } else {
            if (node.saveAs !== undefined) {
              this.vars[node.saveAs] = finalText ?? "";
              changed.push(node.saveAs);
            }
            this.clearError(node.id, changed);
            done(node.next, {
              varsChanged: changed,
              ...(tokens ? { tokens } : {}),
            });
          }
          break;
        }
      }
    }
  }
}

function errorCode(err: unknown, fallback = "ROUTE_ERROR"): string {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === "string" && c !== "" ? c : fallback;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
