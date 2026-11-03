import { agentLog } from "@voicethere/agent";
import { defineTool } from "@voicethere/agent/llm";
import type { Crm, Ticket } from "./mock-crm.js";
import { mockCrm } from "./mock-crm.js";

const CRM_TIMEOUT_MS = 3000;
const MAX_STEP_CHARS = 500;
const MAX_PENDING_STEPS = 20;
const TICKET_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** HTTP client for your CRM. See the README for the four calls it makes. */
export function createHttpCrm(baseUrl: string, apiKey: string): Crm {
  const base = baseUrl.replace(/\/+$/, "");
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(CRM_TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (!res.ok)
      throw new Error(`CRM request failed with status ${res.status}`);
    return (await res.json()) as unknown;
  };
  const user = (id: string) => `/users/${encodeURIComponent(id)}`;
  return {
    async listOpenTickets(userId) {
      const r = await call("GET", `${user(userId)}/tickets?status=open`);
      return Array.isArray(r) ? (r as Ticket[]) : [];
    },
    async getTicket(userId, ticketId) {
      const r = await call(
        "GET",
        `${user(userId)}/tickets/${encodeURIComponent(ticketId)}`,
      );
      return r ? (r as Ticket) : null;
    },
    async addStep(userId, ticketId, step) {
      const r = await call(
        "POST",
        `${user(userId)}/tickets/${encodeURIComponent(ticketId)}/steps`,
        { step },
      );
      return r !== null;
    },
    async createTicket(userId, input) {
      const r = await call("POST", `${user(userId)}/tickets`, input);
      return r as Ticket;
    },
  };
}

/** The HTTP CRM when a CRM URL is set, the in-memory one otherwise. */
export function defaultCrm(): Crm {
  const url = process.env.AGENT_CRM_API_URL ?? process.env.CRM_API_URL;
  if (!url) return mockCrm;
  const key = process.env.AGENT_CRM_API_KEY ?? process.env.CRM_API_KEY ?? "";
  return createHttpCrm(url, key);
}

export interface PendingStep {
  userId: string;
  ticketId: string;
  step: string;
}

/** Steps the model recorded during a call. `onSessionEnd` writes them to the CRM. */
export class PendingSteps {
  private readonly bySession = new Map<string, PendingStep[]>();
  /** Returns false when the session already holds the maximum. */
  add(sessionId: string, s: PendingStep): boolean {
    const list = this.bySession.get(sessionId) ?? [];
    if (list.length >= MAX_PENDING_STEPS) return false;
    list.push({ ...s, step: s.step.slice(0, MAX_STEP_CHARS) });
    this.bySession.set(sessionId, list);
    return true;
  }
  take(sessionId: string): PendingStep[] {
    const list = this.bySession.get(sessionId) ?? [];
    this.bySession.delete(sessionId);
    return list;
  }
}

export const pendingSteps = new PendingSteps();

const UNAVAILABLE = "The ticket system is unavailable right now.";
const LOGIN = "Ask the caller to log in first; account actions need a login.";

export function formatTicket(t: Ticket): string {
  const steps = t.stepsTried.length
    ? ` Steps already tried: ${t.stepsTried.join("; ")}.`
    : "";
  return `${t.id}: ${t.title}. ${t.summary}${steps}`;
}

/**
 * The ticket tools. The user comes only from the session (`ctx.user.id`); no tool
 * takes a user id as input, so a spoken "I am user 456" changes nothing.
 */
export function createTools(deps: { crm?: () => Crm; pending?: PendingSteps }) {
  const crm = deps.crm ?? defaultCrm;
  const pending = deps.pending ?? pendingSteps;
  const failed = (sessionId: string, tool: string, e: unknown) => {
    agentLog(
      "warn",
      "crm tool failed",
      { tool, error: e instanceof Error ? e.name : "Error" },
      sessionId,
    );
    return UNAVAILABLE;
  };
  const ticketIdSchema = { type: "string", maxLength: 64 };

  return [
    defineTool({
      name: "get_open_tickets",
      description:
        "The caller's open support tickets, with the steps already tried.",
      inputSchema: { type: "object", additionalProperties: false },
      requiresVerifiedUser: true,
      handler: async (_args, ctx) => {
        if (!ctx.user) return LOGIN;
        try {
          const list = await crm().listOpenTickets(ctx.user.id);
          return list.length
            ? list.map(formatTicket).join("\n")
            : "No open tickets.";
        } catch (e) {
          return failed(ctx.sessionId, "get_open_tickets", e);
        }
      },
    }),
    defineTool<{ ticketId?: unknown }>({
      name: "get_ticket",
      description: "One of the caller's tickets by its id.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["ticketId"],
        properties: { ticketId: ticketIdSchema },
      },
      requiresVerifiedUser: true,
      handler: async (args, ctx) => {
        if (!ctx.user) return LOGIN;
        if (
          typeof args.ticketId !== "string" ||
          !TICKET_ID.test(args.ticketId)
        ) {
          return "Invalid ticket id.";
        }
        try {
          const t = await crm().getTicket(ctx.user.id, args.ticketId);
          return t ? formatTicket(t) : "No such ticket.";
        } catch (e) {
          return failed(ctx.sessionId, "get_ticket", e);
        }
      },
    }),
    defineTool<{ ticketId?: unknown; step?: unknown }>({
      name: "add_troubleshooting_step",
      description:
        "Record a troubleshooting step the caller just tried on one of their tickets. It is saved when the call ends.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["ticketId", "step"],
        properties: {
          ticketId: ticketIdSchema,
          step: { type: "string", maxLength: MAX_STEP_CHARS },
        },
      },
      requiresVerifiedUser: true,
      handler: async (args, ctx) => {
        if (!ctx.user) return LOGIN;
        if (
          typeof args.ticketId !== "string" ||
          !TICKET_ID.test(args.ticketId) ||
          typeof args.step !== "string" ||
          args.step.trim() === ""
        ) {
          return "Invalid ticket id or step.";
        }
        try {
          const t = await crm().getTicket(ctx.user.id, args.ticketId);
          if (!t) return "No such ticket.";
          const ok = pending.add(ctx.sessionId, {
            userId: ctx.user.id,
            ticketId: args.ticketId,
            step: args.step.trim(),
          });
          return ok ? "Step noted." : "Too many steps recorded in this call.";
        } catch (e) {
          return failed(ctx.sessionId, "add_troubleshooting_step", e);
        }
      },
    }),
    defineTool<{ title?: unknown; summary?: unknown }>({
      name: "create_ticket",
      description: "Open a new support ticket for the caller.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["title", "summary"],
        properties: {
          title: { type: "string", maxLength: 120 },
          summary: { type: "string", maxLength: 1000 },
        },
      },
      requiresVerifiedUser: true,
      handler: async (args, ctx) => {
        if (!ctx.user) return LOGIN;
        if (
          typeof args.title !== "string" ||
          typeof args.summary !== "string" ||
          args.title.trim() === ""
        ) {
          return "A title and a summary are required.";
        }
        try {
          const t = await crm().createTicket(ctx.user.id, {
            title: args.title.trim().slice(0, 120),
            summary: args.summary.trim().slice(0, 1000),
          });
          return `Ticket ${t.id} created.`;
        } catch (e) {
          return failed(ctx.sessionId, "create_ticket", e);
        }
      },
    }),
  ];
}

export const tools = createTools({});
