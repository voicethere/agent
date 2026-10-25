export type TemplateKind = "product" | "e2e";

export type TemplateCategory =
  | "voice"
  | "data"
  | "voice-data"
  | "integration"
  | "debug";

export interface AgentTemplateDefinition {
  id: string;
  /** Path relative to `templates/` (e.g. `echo/agent.ts`, `redis-sync/agent.ts`). */
  entry: string;
  kind: TemplateKind;
  /** When true, a prebuilt bundle is published at `dist/templates/<id>/agent.js`. */
  seedOnCreate: boolean;
  /** Short label for template pickers. */
  title: string;
  /** One sentence for template pickers; `description` stays the long text. */
  summary: string;
  /** Picker grouping. */
  category: TemplateCategory;
  description: string;
  /** All source files for this template (TypeScript, JSON, Markdown) (project-relative paths). */
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
    title: "Echo (voice + chat)",
    summary: "Echo debug agent with voice finals and DataChannel chat.",
    category: "debug",
    description:
      "Full echo debug agent — voice finals and DataChannel chat with TTS playback.",
    sourceFiles: ["echo/agent.ts"],
  },
  {
    id: "echo-dc",
    entry: "echo-dc/agent.ts",
    kind: "product",
    seedOnCreate: true,
    title: "Echo debug (DC events only)",
    summary: "Data-channel-only echo agent without TTS.",
    category: "debug",
    description:
      "Data-channel-only echo — relays speech events and chat without TTS.",
    sourceFiles: ["echo-dc/agent.ts"],
  },
  {
    id: "language-switch",
    entry: "language-switch/agent.ts",
    kind: "product",
    seedOnCreate: true,
    title: "Language switch",
    summary: "Detects the caller's language and switches speech recognition and voice mid-call, with a holding message and an unavailable notice.",
    category: "voice",
    description:
      "Switches STT and TTS independently from onUserLanguage, and can change one vendor mid-conversation. With project auto-switch on, the runner switches and replays the utterance, and the agent answers the recognized text in the new language. With auto-switch off, detection does not change either side until this agent calls setVoiceLanguage.",
    sourceFiles: ["language-switch/agent.ts"],
  },
  {
    id: "voice-starter",
    entry: "voice-starter/agent.ts",
    kind: "product",
    seedOnCreate: true,
    title: "Voice starter",
    summary: "Starter agent covering every speech event.",
    category: "voice",
    description:
      "Voice starter covering every speech event — customize onUserSpeechFinal for your LLM.",
    sourceFiles: ["voice-starter/agent.ts"],
  },
  {
    id: "world-sync",
    entry: "world-sync/agent.ts",
    kind: "product",
    seedOnCreate: true,
    title: "World sync (JSON)",
    summary: "Data-only pose broadcast over onDataChannelMessage. One agent, no Redis.",
    category: "data",
    description:
      "Single-agent JSON world sync — onDataChannelMessage pose updates, in-memory, no Redis.",
    sourceFiles: ["world-sync/agent.ts"],
  },
  {
    id: "world-sync-binary",
    entry: "world-sync-binary/agent.ts",
    kind: "product",
    seedOnCreate: true,
    title: "World sync (binary)",
    summary: "Data-only ArrayBuffer poses with onDataChannelBinary. One agent, no Redis.",
    category: "data",
    description:
      "Single-agent binary world sync — onDataChannelBinary + sendBinaryToClient ArrayBuffer poses, no Redis.",
    sourceFiles: [
      "world-sync-binary/agent.ts",
      "world-sync-binary/protocol.ts",
    ],
  },
  {
    id: "game-sync",
    entry: "game-sync/agent.ts",
    kind: "product",
    seedOnCreate: true,
    title: "Game sync (multi-object DC)",
    summary: "Authoritative multi-object sync sample for real-time games.",
    category: "data",
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
    title: "Voice showcase",
    summary: "Conversational demo: greeting, name, menu (weather, count, recipes, fun facts).",
    category: "voice",
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
    title: "Recording consent",
    summary: "Asks recording consent on connect, pauses for name and birthdate, resumes only if allowed.",
    category: "voice",
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
    title: "Orbiting TTS",
    summary: "Voice+Data demo: a TTS speaker circles each listener with per-client poses.",
    category: "voice-data",
    description:
      "Voice+Data demo — TTS speaker orbits each listener with per-client setTtsPose.",
    sourceFiles: ["positional-tts/agent.ts", "positional-tts/orbit.ts"],
  },
  {
    id: "spatial-showcase",
    entry: "spatial-showcase/agent.ts",
    kind: "product",
    seedOnCreate: true,
    title: "Spatial audio showcase",
    summary: "Voice+Data demo: orbiting sine tone and TTS, positional soundboard, and a proximity room via DataChannel join.",
    category: "voice-data",
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
    title: "Inbound webhooks",
    summary: "Verifies inbound webhooks with HMAC, then fans out over DataChannel and speech.",
    category: "integration",
    description:
      "Inbound webhook handler — HMAC verify on raw body, then DataChannel + speak fan-out.",
    sourceFiles: ["webhooks/agent.ts"],
  },
  {
    id: "webhooks-redis",
    entry: "webhooks-redis/agent.ts",
    kind: "product",
    seedOnCreate: true,
    title: "Inbound webhooks (Redis)",
    summary: "Webhook handler with a Redis shared counter and DataChannel fan-out.",
    category: "integration",
    description:
      "Webhook handler with Redis atomic shared counter plus DataChannel fan-out.",
    sourceFiles: ["webhooks-redis/agent.ts"],
    npmDependencies: { ioredis: "^5.11.1" },
  },
  {
    id: "llm-agent",
    entry: "llm-agent/agent.ts",
    kind: "product",
    seedOnCreate: true,
    title: "LLM agent",
    summary:
      "Voice and chat agent powered by an LLM, with tools and MCP servers.",
    category: "voice-data",
    description:
      "Answers voice finals and chat messages with an LLM from OpenAI, Anthropic, Gemini or OpenRouter, streamed sentence by sentence into TTS. Settings live in voicethere.llm.json and the system prompt in prompt.md; tools, MCP servers and hooks extend it.",
    sourceFiles: [
      "llm-agent/agent.ts",
      "llm-agent/voicethere.llm.json",
      "llm-agent/prompt.md",
      "llm-agent/tools.ts",
      "llm-agent/hooks.ts",
      "llm-agent/md.d.ts",
    ],
    npmDependencies: {
      openai: "^7.43.0",
      "@anthropic-ai/sdk": "^1.3.0",
      "@google/genai": "^2.31.0",
      "@modelcontextprotocol/sdk": "^1.32.2",
    },
  },
  {
    id: "echo-smoke",
    entry: "echo-smoke/agent.ts",
    kind: "e2e",
    seedOnCreate: false,
    title: "Echo smoke",
    summary: "Minimal echo agent for e2e voice-smoke, agent-smoke, and cli-smoke uploads.",
    category: "debug",
    description:
      "Minimal echo agent for e2e voice-smoke, agent-smoke, and cli-smoke uploads.",
    sourceFiles: ["echo-smoke/agent.ts"],
  },
  {
    id: "crash",
    entry: "crash/agent.ts",
    kind: "e2e",
    seedOnCreate: false,
    title: "Crash test",
    summary: "Crash / echo agent for session-errors-smoke and agent-crash-policy smokes.",
    category: "debug",
    description:
      "Crash / echo agent for session-errors-smoke and agent-crash-policy smokes.",
    sourceFiles: ["crash/agent.ts"],
  },
  {
    id: "game-sync-smoke",
    entry: "game-sync-smoke/agent.ts",
    kind: "e2e",
    seedOnCreate: false,
    title: "Game sync smoke",
    summary: "Minimal data-channel agent for deploy-smoke, shared-child, and idle smokes.",
    category: "debug",
    description:
      "Minimal data-channel agent for deploy-smoke, shared-child, and idle smokes.",
    sourceFiles: ["game-sync-smoke/agent.ts"],
  },
  {
    id: "redis-sync",
    entry: "redis-sync/agent.ts",
    kind: "e2e",
    seedOnCreate: false,
    title: "Redis sync",
    summary: "Redis-backed world buffer sync for redis-sync-smoke.",
    category: "debug",
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
    title: "Mix smoke",
    summary: "Positional mix DC commands for voice-data-mix-smoke (Voice+Data, shared child).",
    category: "debug",
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
