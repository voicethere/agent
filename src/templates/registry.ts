export type TemplateKind = "product" | "e2e";

export interface AgentTemplateDefinition {
  id: string;
  /** Path relative to `templates/` (e.g. `echo.ts`, `redis-sync/agent.ts`). */
  entry: string;
  kind: TemplateKind;
  /** When true, a prebuilt bundle is published at `dist/templates/<id>/agent.js`. */
  seedOnCreate: boolean;
  description: string;
  /** All TypeScript sources for this template (project-relative paths). */
  sourceFiles: string[];
}

export const AGENT_TEMPLATES: readonly AgentTemplateDefinition[] = [
  {
    id: "echo",
    entry: "echo.ts",
    kind: "product",
    seedOnCreate: true,
    description:
      "Full echo debug agent — voice finals and DataChannel chat with TTS playback.",
    sourceFiles: ["echo.ts"],
  },
  {
    id: "echo-dc",
    entry: "echo-dc.ts",
    kind: "product",
    seedOnCreate: true,
    description:
      "Data-channel-only echo — relays speech events and chat without TTS.",
    sourceFiles: ["echo-dc.ts"],
  },
  {
    id: "voice-starter",
    entry: "agent.ts",
    kind: "product",
    seedOnCreate: true,
    description:
      "Voice starter covering every speech event — customize onUserSpeechFinal for your LLM.",
    sourceFiles: ["agent.ts"],
  },
  {
    id: "game-sync",
    entry: "game-sync.ts",
    kind: "product",
    seedOnCreate: true,
    description:
      "Authoritative multi-object sync sample for real-time games and simulations.",
    sourceFiles: ["game-sync.ts"],
  },
  {
    id: "webhooks",
    entry: "webhooks.ts",
    kind: "product",
    seedOnCreate: true,
    description:
      "Inbound webhook handler — HMAC verify on raw body, then DataChannel + speak fan-out.",
    sourceFiles: ["webhooks.ts"],
  },
  {
    id: "webhooks-redis",
    entry: "webhooks-redis.ts",
    kind: "product",
    seedOnCreate: true,
    description:
      "Webhook handler with Redis atomic shared counter plus DataChannel fan-out.",
    sourceFiles: ["webhooks-redis.ts"],
  },
  {
    id: "echo-smoke",
    entry: "echo-smoke.ts",
    kind: "e2e",
    seedOnCreate: false,
    description:
      "Minimal echo agent for e2e voice-smoke, agent-smoke, and cli-smoke uploads.",
    sourceFiles: ["echo-smoke.ts"],
  },
  {
    id: "crash",
    entry: "crash.ts",
    kind: "e2e",
    seedOnCreate: false,
    description:
      "Crash / echo agent for session-errors-smoke and agent-crash-policy smokes.",
    sourceFiles: ["crash.ts"],
  },
  {
    id: "game-sync-smoke",
    entry: "game-sync-smoke.ts",
    kind: "e2e",
    seedOnCreate: false,
    description:
      "Minimal data-channel agent for deploy-smoke, shared-child, and idle smokes.",
    sourceFiles: ["game-sync-smoke.ts"],
  },
  {
    id: "redis-sync",
    entry: "redis-sync/agent.ts",
    kind: "e2e",
    seedOnCreate: false,
    description:
      "Redis-backed world buffer sync for redis-sync-smoke (Advanced tier + project Redis).",
    sourceFiles: ["redis-sync/agent.ts", "redis-sync/world-layout.ts"],
  },
] as const;

export type AgentTemplateId = (typeof AGENT_TEMPLATES)[number]["id"];

const TEMPLATE_BY_ID = new Map<string, AgentTemplateDefinition>(
  AGENT_TEMPLATES.map((template) => [template.id, template]),
);

export function isAgentTemplateId(id: string): id is AgentTemplateId {
  return TEMPLATE_BY_ID.has(id);
}

export function getTemplateById(id: string): AgentTemplateDefinition {
  const template = TEMPLATE_BY_ID.get(id);
  if (!template) {
    throw new Error(`Unknown agent template id: ${id}`);
  }
  return template;
}

export function listSeedOnCreateTemplates(): AgentTemplateDefinition[] {
  return AGENT_TEMPLATES.filter((template) => template.seedOnCreate);
}
