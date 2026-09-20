export type TemplateKind = "product" | "e2e";

export interface AgentTemplateDefinition {
  id: string;
  /** Path relative to `templates/` (e.g. `echo/agent.ts`, `redis-sync/agent.ts`). */
  entry: string;
  kind: TemplateKind;
  /** When true, a prebuilt bundle is published at `dist/templates/<id>/agent.js`. */
  seedOnCreate: boolean;
  description: string;
  /** All TypeScript sources for this template (project-relative paths). */
  sourceFiles: string[];
  /** Extra npm dependencies for customer template workspaces (caret semver specs). */
  npmDependencies?: Record<string, string>;
}

export const AGENT_TEMPLATES: readonly AgentTemplateDefinition[] = [
  {
    id: "echo",
    entry: "echo/agent.ts",
    kind: "product",
    seedOnCreate: true,
    description:
      "Full echo debug agent — voice finals and DataChannel chat with TTS playback.",
    sourceFiles: ["echo/agent.ts"],
  },
  {
    id: "echo-dc",
    entry: "echo-dc/agent.ts",
    kind: "product",
    seedOnCreate: true,
    description:
      "Data-channel-only echo — relays speech events and chat without TTS.",
    sourceFiles: ["echo-dc/agent.ts"],
  },
  {
    id: "voice-starter",
    entry: "voice-starter/agent.ts",
    kind: "product",
    seedOnCreate: true,
    description:
      "Voice starter covering every speech event — customize onUserSpeechFinal for your LLM.",
    sourceFiles: ["voice-starter/agent.ts"],
  },
  {
    id: "world-sync",
    entry: "world-sync/agent.ts",
    kind: "product",
    seedOnCreate: true,
    description:
      "Single-agent JSON world sync — onDataChannelMessage pose updates, in-memory, no Redis.",
    sourceFiles: ["world-sync/agent.ts"],
  },
  {
    id: "world-sync-binary",
    entry: "world-sync-binary/agent.ts",
    kind: "product",
    seedOnCreate: true,
    description:
      "Single-agent binary world sync — onDataChannelBinary + sendBinaryToClient ArrayBuffer poses, no Redis.",
    sourceFiles: ["world-sync-binary/agent.ts", "world-sync-binary/protocol.ts"],
  },
  {
    id: "game-sync",
    entry: "game-sync/agent.ts",
    kind: "product",
    seedOnCreate: true,
    description:
      "Authoritative multi-object sync with binary world snapshots; uses Redis when AGENT_REDIS_URL is set.",
    sourceFiles: [
      "game-sync/agent.ts",
      "game-sync/protocol.ts",
      "game-sync/world-layout.ts",
      "game-sync/sim.ts",
      "game-sync/redis.ts",
    ],
    npmDependencies: { ioredis: "^5.11.1" },
  },
  {
    id: "voice-showcase",
    entry: "voice-showcase/agent.ts",
    kind: "product",
    seedOnCreate: true,
    description:
      "Conversational voice showcase — greeting, name, menu (weather, count, recipe, fun fact).",
    sourceFiles: [
      "voice-showcase/agent.ts",
      "voice-showcase/conversation.ts",
      "voice-showcase/delivery.ts",
      "voice-showcase/weather.ts",
      "voice-showcase/recipes.ts",
      "voice-showcase/fun-facts.ts",
    ],
  },
  {
    id: "recording-consent",
    entry: "recording-consent/agent.ts",
    kind: "product",
    seedOnCreate: true,
    description:
      "Recording consent flow — ask consent, pause capture for PII, resume when allowed.",
    sourceFiles: [
      "recording-consent/agent.ts",
      "recording-consent/conversation.ts",
    ],
  },
  {
    id: "positional-tts",
    entry: "positional-tts/agent.ts",
    kind: "product",
    seedOnCreate: true,
    description:
      "Voice+Data demo — TTS speaker orbits each listener with per-client setTtsPose.",
    sourceFiles: ["positional-tts/agent.ts", "positional-tts/orbit.ts"],
  },
  {
    id: "spatial-showcase",
    entry: "spatial-showcase/agent.ts",
    kind: "product",
    seedOnCreate: true,
    description:
      "Spatial audio showcase — orbiting sine + TTS, positional clip soundboard, proximity room via DataChannel commands.",
    sourceFiles: [
      "spatial-showcase/agent.ts",
      "spatial-showcase/protocol.ts",
      "spatial-showcase/sounds.ts",
      "spatial-showcase/room.ts",
      "spatial-showcase/orbit.ts",
      "spatial-showcase/orbit-session.ts",
      "spatial-showcase/sine.ts",
    ],
  },
  {
    id: "webhooks",
    entry: "webhooks/agent.ts",
    kind: "product",
    seedOnCreate: true,
    description:
      "Inbound webhook handler — HMAC verify on raw body, then DataChannel + speak fan-out.",
    sourceFiles: ["webhooks/agent.ts"],
  },
  {
    id: "webhooks-redis",
    entry: "webhooks-redis/agent.ts",
    kind: "product",
    seedOnCreate: true,
    description:
      "Webhook handler with Redis atomic shared counter plus DataChannel fan-out.",
    sourceFiles: ["webhooks-redis/agent.ts"],
    npmDependencies: { ioredis: "^5.11.1" },
  },
  {
    id: "echo-smoke",
    entry: "echo-smoke/agent.ts",
    kind: "e2e",
    seedOnCreate: false,
    description:
      "Minimal echo agent for e2e voice-smoke, agent-smoke, and cli-smoke uploads.",
    sourceFiles: ["echo-smoke/agent.ts"],
  },
  {
    id: "crash",
    entry: "crash/agent.ts",
    kind: "e2e",
    seedOnCreate: false,
    description:
      "Crash / echo agent for session-errors-smoke and agent-crash-policy smokes.",
    sourceFiles: ["crash/agent.ts"],
  },
  {
    id: "game-sync-smoke",
    entry: "game-sync-smoke/agent.ts",
    kind: "e2e",
    seedOnCreate: false,
    description:
      "Minimal data-channel agent for deploy-smoke, shared-child, and idle smokes.",
    sourceFiles: ["game-sync-smoke/agent.ts"],
  },
  {
    id: "redis-sync",
    entry: "redis-sync/agent.ts",
    kind: "e2e",
    seedOnCreate: false,
    description:
      "Redis-backed world buffer sync for redis-sync-smoke — binary 12-byte position frames + project Redis.",
    sourceFiles: ["redis-sync/agent.ts", "redis-sync/world-layout.ts"],
    npmDependencies: { ioredis: "^5.11.1" },
  },
  {
    id: "mix-smoke",
    entry: "mix-smoke/agent.ts",
    kind: "e2e",
    seedOnCreate: false,
    description:
      "Positional mix DC commands for voice-data-mix-smoke (Voice+Data, shared child).",
    sourceFiles: ["mix-smoke/agent.ts"],
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
