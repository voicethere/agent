/** A valid flow used as the base for validator tests. */
export function baseFlow(): any {
  return {
    version: 1,
    start: "greet",
    models: {
      default: {
        provider: "openrouter",
        model: "amazon/nova-micro-v1",
        apiKeySecret: "AGENT_OPENROUTER_API_KEY",
      },
      classifier: { use: "default" },
    },
    secrets: ["AGENT_CRM_TOKEN"],
    variables: { customerId: { type: "string" } },
    tools: {
      toolSources: [
        { kind: "mcp", name: "crm", url: "https://mcp.example.com/mcp" },
      ],
    },
    nodes: [
      {
        id: "greet",
        type: "speak",
        text: "Hi, billing or support?",
        next: "ask",
      },
      {
        id: "ask",
        type: "listen",
        timeoutMs: 8000,
        next: "topic",
        onNoInput: "reprompt",
      },
      {
        id: "reprompt",
        type: "speak",
        text: "Sorry, I did not hear you.",
        next: "ask",
      },
      {
        id: "topic",
        type: "route",
        input: "{{last.transcript}}",
        paths: [
          {
            id: "billing",
            examples: ["my invoice", "charged twice"],
            keywords: ["invoice"],
            next: "lookup",
          },
          { id: "support", examples: ["app is broken"], next: "llmHelp" },
        ],
        onNone: "reprompt",
        onError: "fallback",
      },
      {
        id: "lookup",
        type: "http",
        method: "GET",
        url: "https://api.example.com/customers/{{customerId}}",
        headers: {
          Authorization: { secret: "AGENT_CRM_TOKEN", prefix: "Bearer " },
        },
        map: { balance: "/balance" },
        next: "tell",
        onError: "fallback",
      },
      {
        id: "llmHelp",
        type: "llm",
        instructions: "Help in two sentences.",
        send: "conversation",
        saveAs: "answer",
        next: "end",
        onError: "fallback",
      },
      {
        id: "tell",
        type: "speak",
        text: "Balance {{balance}} ({{lookup.status}}).",
        next: "end",
      },
      {
        id: "fallback",
        type: "speak",
        text: "Something went wrong. {{error.lookup}}",
        next: "end",
      },
      { id: "end", type: "end", reason: "done" },
    ],
  };
}
