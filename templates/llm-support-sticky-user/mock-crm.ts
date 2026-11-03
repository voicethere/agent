// An in-memory CRM for local runs and tests. The agent uses it when no CRM URL is
// set. Every call is scoped to one user id, like the HTTP contract in the README.

export interface Ticket {
  id: string;
  title: string;
  summary: string;
  status: "open" | "closed";
  stepsTried: string[];
}

export interface Crm {
  listOpenTickets(userId: string): Promise<Ticket[]>;
  getTicket(userId: string, ticketId: string): Promise<Ticket | null>;
  /** Returns false when the user has no such ticket. */
  addStep(userId: string, ticketId: string, step: string): Promise<boolean>;
  createTicket(
    userId: string,
    input: { title: string; summary: string },
  ): Promise<Ticket>;
}

export function createMockCrm(): Crm {
  const tickets = new Map<string, Ticket[]>([
    [
      "demo-user",
      [
        {
          id: "T-1001",
          title: "Router drops the connection every evening",
          summary: "Wi-Fi disconnects for a few minutes between 8 and 10 pm.",
          status: "open",
          stepsTried: [
            "Restarted the router",
            "Moved the router out of the cabinet",
          ],
        },
      ],
    ],
  ]);
  let next = 1002;
  const copy = (t: Ticket): Ticket => ({ ...t, stepsTried: [...t.stepsTried] });
  const find = (userId: string, ticketId: string) =>
    (tickets.get(userId) ?? []).find((t) => t.id === ticketId);
  return {
    async listOpenTickets(userId) {
      return (tickets.get(userId) ?? [])
        .filter((t) => t.status === "open")
        .map(copy);
    },
    async getTicket(userId, ticketId) {
      const t = find(userId, ticketId);
      return t ? copy(t) : null;
    },
    async addStep(userId, ticketId, step) {
      const t = find(userId, ticketId);
      if (!t) return false;
      t.stepsTried.push(step);
      return true;
    },
    async createTicket(userId, input) {
      const t: Ticket = {
        id: `T-${next++}`,
        title: input.title,
        summary: input.summary,
        status: "open",
        stepsTried: [],
      };
      tickets.set(userId, [...(tickets.get(userId) ?? []), t]);
      return copy(t);
    },
  };
}

export const mockCrm: Crm = createMockCrm();
