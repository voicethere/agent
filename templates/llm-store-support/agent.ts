import { defineAgent } from "@voicethere/agent";
import { createLlmAgent } from "@voicethere/agent/llm";
import { openai } from "@voicethere/agent/llm/openai";
import config from "./voicethere.llm.json";
import systemPrompt from "./prompt.md";
import shipping from "./knowledge/shipping.md";
import returns from "./knowledge/returns.md";
import warranty from "./knowledge/warranty.md";
import sizing from "./knowledge/sizing.md";
import store from "./knowledge/store.md";
import products from "./knowledge/products.md";

// Needs Project Redis (the knowledge files are indexed there at start), a
// project service that runs the mcp-example-service image (prices come from
// its get_product_price tool), and the project secret AGENT_OPENROUTER_API_KEY,
// which serves both the chat model and the embeddings. To support your own
// store, replace the files in knowledge/ and point the service at your own MCP
// server (see README.md).
defineAgent(
  createLlmAgent({
    config,
    systemPrompt,
    providers: [openai],
    knowledge: {
      documents: [
        { id: "shipping", title: "Shipping", text: shipping },
        { id: "returns", title: "Returns", text: returns },
        { id: "warranty", title: "Warranty", text: warranty },
        { id: "sizing", title: "Sizing", text: sizing },
        { id: "store", title: "Store hours and contact", text: store },
        { id: "products", title: "Products", text: products },
      ],
    },
  }),
);
