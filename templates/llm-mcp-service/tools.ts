import { defineTool } from "@voicethere/agent/llm";

const getCurrentTime = defineTool<{ timeZone?: string }>({
  name: "get_current_time",
  description: "Current date and time in a time zone.",
  inputSchema: {
    type: "object",
    properties: {
      timeZone: {
        type: "string",
        description: "IANA time zone, e.g. Europe/Berlin",
      },
    },
    additionalProperties: false,
  },
  handler: ({ timeZone }) => {
    const zone = timeZone || "UTC";
    try {
      return new Date().toLocaleString("en-US", {
        timeZone: zone,
        dateStyle: "full",
        timeStyle: "short",
      });
    } catch {
      return `Unknown time zone: ${zone}`;
    }
  },
});

// Example: a tool that calls an HTTP API. Keep every request bounded.
//
// const lookupOrder = defineTool<{ orderId: string }>({
//   name: "lookup_order",
//   description: "Status of an order by its id.",
//   inputSchema: {
//     type: "object",
//     properties: { orderId: { type: "string" } },
//     required: ["orderId"],
//     additionalProperties: false,
//   },
//   handler: async ({ orderId }) => {
//     const res = await fetch(
//       `https://api.example.com/orders/${encodeURIComponent(orderId)}`,
//       { signal: AbortSignal.timeout(5000) },
//     );
//     if (!res.ok) return `Order lookup failed with status ${res.status}`;
//     return await res.text();
//   },
// });

export const tools = [getCurrentTime];
