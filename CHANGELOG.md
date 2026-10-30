# Changelog

All notable changes to `@voicethere/agent` are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/). Versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.20.1] - 2026-10-31

### Fixed

- LLM agent: the greeting is sent as spoken assistant text (`assistant_delta`/`assistant_done`, `spoken: true`), so `onAgentText` shows it like any spoken reply.

## [0.20.0] - 2026-10-30

### Changed

- Voice replies of an `llm-agent` project now also reach the client as text. Each spoken sentence is sent as `assistant_delta` and the turn ends with one `assistant_done`, both with `spoken: true` and the same `turnId`. `assistant_done` carries `status` (`completed`, `failed`, `interrupted` or `cancelled`) and the text of the sentences delivered so far. When the runner sends an utterance id for the caller's final, both also carry `inReplyTo` (the caller utterance the reply answers), and the speak requests of that reply carry it too. `onUserSpeechFinal` receives it as `ctx.utteranceId`. Voice turns send no `chat_reply`. Chat turns are unchanged. Fillers and announcements send no text.
- The `llm-agent` and `llm-mcp-service` templates' `fillers.thinking.phrases` are now `Okay.`, `Right.`, `Sure.` and `Let me see.`: the old `Hmm.` and `Mm-hm.` were read out letter by letter. Existing projects keep their own phrases; edit `fillers.thinking.phrases` in `voicethere.llm.json` to change them.

## [0.19.0] - 2026-10-28

### Added

- Session time limit control. `getSessionTimeLimit`, `setSessionTimeLimit`, `enableSessionTimeLimit` and `disableSessionTimeLimit` read, disable or (re-)enable the project's session limit for one session, with minutes (integer 1 to 1440) and a close reason (up to 200 characters) the client sees. Each returns `{ ok: true, state }` or `{ ok: false, error }` (`invalid_minutes`, `invalid_reason`, `no_limit_minutes`, `session_closing`, `unknown_session`, `unsupported`, `timeout`). The new handler `onSessionTimeLimit` runs before the client is told and before the session closes, so the agent can say goodbye; the runner waits up to `ctx.graceMs` (10 s). `ctx.sessionTimeLimitAvailable` is `true` on runners that support it; older runners return `unsupported`. New IPC messages: `session_time_limit_control`, `session_time_limit_control_ack`, `session_time_limit`, `session_time_limit_done`.

## [0.18.2] - 2026-10-28

### Fixed

- A tool turn could end on "Let me check that for you." without the tool being called. The `llm-agent` and `llm-mcp-service` template prompts and `CALL_AGENT_PROMPT_GUIDANCE` no longer ask the model to say a sentence before a tool call; the tool-call fillers already cover that moment.

## [0.18.1] - 2026-10-27

### Fixed

- An LLM agent no longer speaks or shows `<thinking>...</thinking>` blocks. The blocks are removed from chat messages, speech and the history the model sees on the next turn, also when a tag arrives split over several chunks; an opening tag without a closing tag drops the rest of that reply. The `llm turn` log line carries `thinkingCharsStripped`, a count only, never the text.

## [0.18.0] - 2026-10-27

### Added

- The `llm-agent` template ships a sample `knowledge/about.md` and a `knowledge` block in `voicethere.llm.json` with `"store": "off"`. Set `"store": "redis"` (Project Redis) or `"supabase"` to turn retrieval on; the template README explains the three steps.
- New product template `llm-mcp-service`: the `llm-agent` template with the project service as its tool source (`toolSources: [{ "kind": "service", "path": "/mcp" }]`), plus a README section for external MCP servers (`kind: "mcp"` with bearer auth).
- Example MCP server `services/mcp-example` (streamable HTTP at `/mcp`, `GET /healthz`, tools `get_plan_price` with sample data and `get_server_time`), published on each release as the public image `ghcr.io/voicethere/mcp-example-service:<version>` and `:latest`. Set it as the project service image, port 8080, health check `/healthz`.
- `@voicethere/agent/llm` exports `createLlmEmbedder` and `withEmbedBounds`: text embeddings for `openai`, `openrouter` and `gemini` (the OpenAI and Gemini provider modules gain `createEmbedder`). Calls are bounded (15 s per attempt, two retries, 96 inputs per request), check the vector length and return L2-normalized vectors. `anthropic` throws the new error code `LLM_EMBEDDINGS_UNSUPPORTED`. Also exported: `DEFAULT_EMBEDDING_MODEL` (`text-embedding-3-small`, `gemini-embedding-001`), `DEFAULT_EMBEDDING_DIMS` (512) and the types `LlmEmbedder`, `EmbeddingsRequest`, `EmbeddingsResult`, `EmbedBounds`.

- `@voicethere/agent/llm` exports `createRedisKnowledgeBase` and `chunkMarkdown`: a knowledge base (RAG) on Project Redis 8 vector search. Markdown documents are split by heading into chunks of about 300 words (50-word overlap), embedded with your embedder and stored as a versioned HNSW index (cosine, no TTL). `ensureIndexed()` hashes the documents, model and dimensions and skips embedding when nothing changed; when several workers with the same content start together one builds and the others wait (the build lock is renewed while it runs). Every content version has its own index, so old and new workers of a rolling deploy each search their own version; open knowledge bases send a heartbeat, and `gc()` (also run after a build) drops the index of a version whose workers stopped. `search(query, k)` returns the top chunks with title, source and score and rebuilds the index if it is missing. The index refuses to grow past 80 % of `maxmemory` with `KnowledgeIndexError` code `KB_MEMORY_LIMIT`. Every Redis call is bounded and log lines carry counts and durations only, never chunk or query text. Needs Redis with the Query Engine (Redis 8) and `ioredis` in your agent. Also exported: `KnowledgeIndexError` and the types `KnowledgeBase`, `KnowledgeDocument`, `KnowledgeHit`, `IndexReport`, `RedisKnowledgeBaseOptions`.

- `@voicethere/agent/llm` exports `createSupabaseKnowledgeBase`, `searchKnowledgeTool` and a `knowledge` block for `voicethere.llm.json`. `createSupabaseKnowledgeBase` calls your own Supabase project's `match_documents` function (the one from the Supabase pgvector guide) over REST: `POST {url}/rest/v1/rpc/match_documents` with `apikey` and bearer headers, bounded to 8 s with one retry on a 5xx or network error. Errors carry the HTTP status only (`KB_SUPABASE_ERROR`), never the key, body or query. With Project Redis the results are cached for 10 minutes (the cache keys carry a TTL, so `volatile-lru` can evict them); a cache failure never fails a search. `searchKnowledgeTool(kb)` is the `search_knowledge` tool the model calls. In `voicethere.llm.json`, `knowledge: { store: "redis" | "supabase" | "off", topK, embeddings, redis, supabase }` wires it up: `createLlmAgent({ knowledge: { documents } })` indexes `store: "redis"` on start (in the background) and registers the tool; without `AGENT_REDIS_URL` or documents it logs once and registers no tool. `anthropic` is rejected as an embeddings provider. The JSON schema gains the `knowledge` block.

### Changed

- `prettier` is pinned to an exact version in `devDependencies`.

## [0.17.0] - 2026-10-27

### Added

- An LLM agent writes one `llm.tool.call` line to the project's agent logs for every tool call (project service, MCP server, custom tool, a call answered by the `onToolCall` hook, or a call to a tool name that does not exist; `kind` is `service`, `mcp`, `custom`, `hook` or `unknown`): tool name, source, input, output, error flag and duration, with the turn and the model's call id. Input and output are cut to 2048 characters.
- Tool-call lines are redacted by default: values of the agent's secrets, values under keys such as `password`, `token`, `apiKey` or `authorization`, and emails, phone numbers, card numbers and IBANs are replaced. Set `"toolCallLogs": "full"` in `voicethere.llm.json` to keep personal data in the line (secret values are still removed), or `"off"` to write no line.
- `@voicethere/agent/llm` exports `secretValuesFromEnv` and the types `ToolCallLogMode` and `ToolCallLogOptions`, used by the ejected LLM loop to build the same tool-call log redaction.

## [0.16.0] - 2026-10-27

### Added

- When an LLM agent connects to a tool source (the project service or an MCP server), it writes one `llm tools discovered` line to the project's agent logs with the tools the source offers (as many as fit the agent log size limit; `truncated` is set when some are left out): name, a description cut to 120 characters and whether the `allow` / `deny` lists expose it. The line is written again only when the tool list changes.

## [0.15.0] - 2026-10-27

### Changed

- The `llm-agent` template now starts on OpenRouter with `amazon/nova-micro-v1` and the project secret `AGENT_OPENROUTER_API_KEY`. Projects that already have a `voicethere.llm.json` keep it.

### Added

- `openrouter` has a default model in the provider catalog, so a config without `model` resolves to `amazon/nova-micro-v1` instead of failing.
- `npm run check:openrouter-model` confirms the default model is listed by OpenRouter and supports tools. The release workflow runs it before publishing.

## [0.14.1] - 2026-10-26

### Fixed

- Bundles built with `@voicethere/agent build` that include the LLM agent (`createLlmAgent`) failed to load with `SyntaxError: Identifier 'createRequire' has already been declared`. The bundle no longer declares a name that bundled modules can also declare.
- `verify` now checks that the bundle parses as a module (new check "Bundle parses"), so a bundle that does not load fails `verify` instead of only timing out in `verify-start`.
- `verify-start` passes `AGENT_*` environment variables to the sandboxed child, as a deployed agent gets its project secrets, so agents that read a key at start (such as the LLM API key) can be verified.

## [0.14.0] - 2026-10-26

### Added

- LLM agents: the `fillers` block in `voicethere.llm.json` has three situations, each with its own phrases: `thinking` (the caller waits for the first sentence, after `afterMs`, default 1500), `toolCall` (the model asked for a tool and has said nothing yet, spoken at once) and `toolWait` (a tool round runs longer than `afterMs`, default 4000). At most 3 fillers per turn, never back to back, never the same phrase twice in a row, and barge-in may cut them (`interruptible`, default true). Fillers are speech only and never reach the conversation sent to the model. Off unless set; the `llm-agent` template ships all three.
- `speech.coalesceMs` (default 150): sentences that complete within the window are spoken as one utterance, so a reply that arrives at once has no gap between sentences. `0` keeps one utterance per sentence.
- `CALL_AGENT_PROMPT_GUIDANCE` exported from `@voicethere/agent/llm`, and a "Voice call" section in the `llm-agent` template prompt.
- `validateLlmAgentConfig` returns `warnings`. `createLlmAgent` accepts a `random` option for tests.

### Deprecated

- `tools.filler` (one fixed text, spoken only during tool calls). It still works when `fillers.toolCall` and `fillers.toolWait` have no phrases; otherwise it is ignored and the agent logs a warning.

## [0.13.0] - 2026-10-25

### Breaking

- `createLlmProvider(config, modules)` and `createLlmAgent({ providers })` now take the provider SDK modules explicitly. Import them from `@voicethere/agent/llm/openai`, `@voicethere/agent/llm/anthropic` or `@voicethere/agent/llm/gemini` (`openrouter` uses the `openai` module). A provider that is selected but not registered throws `LLM_CONFIG_INVALID` from `createLlmAgent()`, so the deploy check reports it.
- Why: a bundle now carries only the selected provider's SDK. The `llm-agent` template bundle drops from 4.8 MB to about 1.8 MB before minification.

## [0.12.1] - 2026-10-25

### Added

- `getService()` / `serviceFetch()` for the project service.

### Fixed

- LLM agent env names use the `AGENT_` prefix (`AGENT_OPENAI_API_KEY`, `AGENT_SERVICE_URL`/`AGENT_SERVICE_TOKEN`); the config validator rejects secret names the sandbox would drop.

## [0.12.0] - 2026-10-25

### Added

- `@voicethere/agent/llm`: streaming provider adapters (OpenAI, Anthropic, Google Gemini, OpenRouter) with first-token and total timeouts.
- `McpToolSource` (Streamable HTTP MCP client with reconnect) and `ToolRegistry` (custom + MCP tools, name rules, 128-tool cap, 16 KiB result cap).
- `createLlmAgent` (`@voicethere/agent/llm`): a turn loop for LLM-driven agents. Streams sentences to `speak()` under one `turnId`, runs tool rounds (parallel calls, filler, round and timeout limits), handles barge-in through `onAgentInterrupted` (history keeps what the caller heard, with an interruption note), and takes chat input from the data channel. Never blocks the session queue.
- `defineTool`, `LlmAgentHooks` (`onBeforeLlmCall`, `onAssistantText`, `onToolCall`, `onToolResult`, `onTurnEnd`, `respond`), `SentenceSplitter` and `ConversationHistory`.
- `validateLlmAgentConfig`, `LLM_AGENT_CONFIG_DEFAULTS` and a JSON Schema for the config at `@voicethere/agent/llm/schema.json`.
- `llm-agent` template (`agent.ts`, `voicethere.llm.json`, `prompt.md`, `tools.ts`, `hooks.ts`), created with a prebuilt seed bundle. The config accepts a top-level `$schema` string.
- `buildAgentBundle` and `agent build` load `.md` and `.txt` imports as text.
- Eject source for the turn loop at `@voicethere/agent/llm/eject/loop.ts` (generated into `eject/llm/loop.ts`), importing only `@voicethere/agent` and `@voicethere/agent/llm`.

## [0.11.0] - 2026-10-25

### Added

- **Speak results**: `speak()` returns a handle with `requestId`, `done` (resolves with `played`, `interrupted`, `cancelled`, `failed` or `unsupported`, plus `playedMs`) and `cancel()`.
- **`turnId` and `inReplyTo`** options on `speak()` to group several speaks into one reply and tie it to the caller turn it answers.
- **`announce()`**: a speak that the caller's speech never cuts or drops from the queue.
- **`cancelSpeech()`**: cancel one speak, one turn, or everything pending for the session.
- **`setBargeIn()` and `withoutBargeIn()`**: switch caller barge-in off for a stretch of work and back on, also when the work throws.
- **`onAgentInterrupted`** handler: after a barge-in cut the agent's speech, reports `playedText`, `unplayedText`, `replyPlayedMs` and the cancelled speaks, in session order before the next `user_speech_final`.
- **`setAgentState()`**: report `listening`, `thinking`, `tool_call` or `speaking` with an optional short detail.
- **`isSpeakControlAvailable()`** and `SessionContext.speakControlAvailable`. On runners without speak control the old behaviour stays: `speak()` plays as before and its result is `unsupported`.
- **`@voicethere/agent/host`**: transport-free host logic (`SessionSpeakController`, `estimatePlayedText`) that implements the parent-side rules for speak results, cancellation, barge-in flushing and the interruption report.

### Changed

- `speak()` returns a handle instead of `undefined`; `speakAndChat()` returns the handle (or `undefined` for empty text).

## [0.10.1] - 2026-10-23

### Fixed

- **mix-smoke template**: the inline clip is a 440 Hz tone. It was a constant value, which Opus removes, so listeners heard two short clicks instead of a 2 s clip.

## [0.10.0] - 2026-10-20

### Added

- **`voicethere` provider id**: `sttVendor.provider` and `ttsVendor.provider` take `voicethere` for the built-in VoiceThere speech. Results show it as `voicethere` in `sttProvider` and `ttsProvider`. The SDK translates the id on the wire, so it also works with older VoiceThere runtimes.
- **`message` on results**: `setVoiceLanguage` and `prepareVoiceLanguage` results carry a `message` that says what to change. When an older runtime sends only a `reason`, the SDK fills in the text for `unknown_stt`, `unknown_voice`, `invalid_language`, `language_unavailable`, `unavailable`, `timeout`, `nothing_to_apply` and `invalid_scope`.
- **Request validation in the SDK**: both calls check the request before sending it and fail with a named `reason` (`invalid_request`, `invalid_scope`, `missing_provider`, `conflicting_fields`, `scope_mismatch`, `unsupported_field`, `nothing_to_apply`).
- **`VoiceSwitchFailureReason`** type, plus `toWireProviderId` and `toPublicProviderId` helpers.
- **Provider lists**: the docs and JSDoc now name every provider the runtime accepts, including `groq`, `azure` and `aws` on both sides.

### Changed

- **`language-switch` template**: the default profile asks for `voicethere` on both sides. The chat commands are `/tts voicethere <lang>` and `/stt voicethere <lang>`; `sherpa` still works as the vendor word. Failed switches log the `message`.

### Deprecated

- Top-level `voice` and `stt` in `setVoiceLanguage` options. Use `ttsVendor.voice` and `sttVendor.model`. Combined with the matching vendor object they fail with `conflicting_fields`.
- The provider ids `local-sherpa` and `cluster-sherpa`. Use `voicethere`.

## [0.9.8] - 2026-10-13

### Added

- **Template registry** — every template definition now has `title` (short label), `summary` (one sentence for pickers) and `category` (`voice`, `data`, `voice-data`, `integration`, `debug`). The VoiceThere dashboard and CLI build their template lists from these fields.

## [0.9.7] - 2026-10-13

### Changed

- **`language-switch` template** — manual mode now names the target language in the holding message it speaks in the current voice when the pools are not ready ("One moment, switching to German."; texts in `HOLDING_MESSAGES`, `{language}` is replaced in project and env texts too). If the pools did not start within 20 seconds, the agent repeats the holding message and prepares once more. If that also times out, or `setVoiceLanguage` answers `language_unavailable`, it says in the current voice that the language isn't available (`UNAVAILABLE_MESSAGES`, override with `LANGUAGE_SWITCH_UNAVAILABLE_MESSAGES_JSON`) and the call stays in the old language, about 40 seconds in total. `WAIT_MESSAGES` remains as another name for `HOLDING_MESSAGES`. New log lines: `language_switch.retry` and `language_switch.unavailable`.
- **README** — documents the `voice_language_switch_failed` fields (`reason: "language_unavailable"`, `error`, `fallbackLanguage`, `attempts`) and the `setVoiceLanguage` result when the new language's models do not start.

## [0.9.6] - 2026-10-05

### Added

- **`prepareVoiceLanguage(sessionId, options)`** — warms the pools for a language switch (same options as `setVoiceLanguage`) and resolves `{ ok, ready, reason, language? }` without changing anything. Resolves `reason: "timeout"` after 50 s on runners that do not support it.
- **`replayLastUtterance(sessionId)`** — asks the runner to run the caller's last utterance through the current STT again. The replayed final reaches `onUserSpeechFinal` with `replay: true`. Resolves `reason: "timeout"` after 10 s on older runners.
- **`getVoiceLanguageSwitchSettings(sessionId)`** — the project's wait and ready messages and timing from `session_start` (`voiceLanguageSwitch`), or `undefined` on older runners.

### Changed

- **`language-switch` template** — manual mode now runs the full switch flow without interrupting the caller. It warms the target pools when the language is detected, leaves the switch utterance unanswered, swaps STT and TTS after the caller stops, and has the runner replay that utterance in the new language. A wait message (current voice) plays only when the pools are not ready, a ready message (new voice) only when the switch was slow, and every step logs a `language_switch.<decision>` line. A per-language `PROFILES` map selects other vendors. Older runners without the new primitives time out and the agent apologises in the old language.

## [0.9.5] - 2026-10-05

### Changed

- **`language-switch` template** — switches voice and STT in one `setVoiceLanguage` call (`scope: "both"`) so both pools start together instead of one after the other.

## [0.9.4] - 2026-10-05

### Added

- **`speak(sessionId, text, { interruptible: false })`** — optional third argument so the caller's speech (barge-in) does not cut that utterance. Needs a runner that supports the field; older runners ignore it and behave as before.

### Fixed

- **`language-switch` template** — the manual-switch wait message is no longer cut by barge-in when early language detection fires while the caller is still talking.

## [0.9.3] - 2026-10-04

### Changed

- **`language-switch` template** — in manual mode (runner auto-switch off) the agent now speaks a per-language wait message in the language being left and waits for `agent_speaking_end` (at most 8 s) before it calls `setVoiceLanguage`, because the runner plays nothing for manual switches and the target pools can be cold for several seconds. If the switch fails it speaks a short fallback in the old language and stays. Override the texts with `LANGUAGE_SWITCH_WAIT_MESSAGES_JSON` and `LANGUAGE_SWITCH_FAILED_MESSAGES_JSON` (JSON object keyed by ISO 639-1 code). Auto mode is unchanged.

## [0.9.2] - 2026-10-03

### Changed

- **`language-switch` template** — with project auto-switch on, the agent now answers what the user said in the new language (for example "Du hast gesagt: …") right after the runner switches and replays the utterance. It no longer speaks a fixed greeting and no longer drops the next transcript. It still never calls `setVoiceLanguage` in this mode. Manual mode is unchanged.

## [0.9.1] - 2026-09-29

### Added

- **`setVoiceLanguage`** — agent code changes STT, TTS, or both for one live session, including the vendor (`sttVendor` / `ttsVendor`). `scope: "stt"` or `"tts"` leaves the other side in place. Spoken-language detection does not change either side until you call it. API keys stay in project secrets.
- **`getVoiceLanguage`** — last known ISO 639-1 from a successful switch ack or LID / `voice_language_changed` events.
- **`onVoiceLanguageChanged`** — `defineAgent` handler when the runner commits a language change (`voice_language_changed` IPC).
- **`voiceLanguageSwitchAvailable`** on `session_start` plus **`isVoiceLanguageSwitchAvailable`** / **`isRunnerLidAutoSwitchEnabled`** helpers for manual vs project auto-switch.
- **`language-switch` template** — `onUserLanguage` switches the Sherpa voice and STT model as two calls. Chat commands `/tts` and `/stt` change one vendor mid-conversation. When `session_start.env` has truthy **`SHERPA_LID_AUTO_SWITCH`**, the template skips `setVoiceLanguage` in `onUserLanguage` (runner owns the switch; use `onVoiceLanguageChanged` for prompts).

## [0.9.0] - 2026-09-27

### Added

- **`setVoiceLanguage`** — agent code changes STT, TTS, or both for one live session, including the vendor (`sttVendor` / `ttsVendor`). `scope: "stt"` or `"tts"` leaves the other side in place. Spoken-language detection does not change either side until you call it. API keys stay in project secrets.
- **`language-switch` template** — `onUserLanguage` switches the Sherpa voice and STT model as two calls. Chat commands `/tts` and `/stt` change one vendor mid-conversation.

## [0.8.3] - 2026-09-26

### Changed

- **`spatial-showcase` orbit** — pose and mix updates run at 60 Hz so the circling voice moves smoothly.
- **`spatial-showcase` clip origins** — `https://www.voicethere.io` and `https://voicethere.io` are allowed asset origins for showcase sound URLs.

## [0.8.2] - 2026-09-24

### Added

- **Conversation history controls:** `setConversationHistoryEnabled`, `enableConversationHistory`, and `disableConversationHistory` (`ConversationHistoryControlMessage`) return `Promise<ConversationHistoryControlResult>` after a parent `conversation_history_control_ack` (`requestId`). `SessionStartMessage.conversationHistoryAvailable` matches `recordingAvailable`.

## [0.8.1] - 2026-09-21

### Added

- **`speakAndChat`** — sends a `chat_reply` to the client, then `speak()` with the same text (send-then-play). Optional `{ stream: true, utteranceId }` adds stream caption metadata for clients with spoken-text streaming enabled. Echo and voice-showcase spoken lines set `stream: true`.

## [0.8.0] - 2026-09-19

### Added

- **World sync templates** — `world-sync` (JSON `onDataChannelMessage`, one in-memory agent, no Redis) and `world-sync-binary` (`onDataChannelBinary` + `sendBinaryToClient` with 12-byte `ArrayBuffer` poses). `game-sync` remains the Redis + binary snapshot starter. Binary templates reuse one pose/snapshot/`Float32Array` world buffer (no per-tick `ArrayBuffer.slice` copies).
- **Per-template folders** — every template now lives in `templates/<id>/` with a `README.md` and `agent.ts` entry (`game-sync` files moved out of the templates root).
- **World-sync tests** — JSON / binary / game-sync / redis-sync agent handler coverage plus Lua tests against real Redis (`AGENT_TEST_REDIS_URL`, localhost:6379, or spawned `redis-server`). Mini-redis remains the sandbox PING mock only.
- **`broadCastBinaryToClients`** is now exported from `@voicethere/agent` — wraps the payload once and fans the same `Buffer` view out to every session.

### Changed

- **Zero-copy `sendBinaryToClient`** — passing a `Uint8Array` (or any typed-array view) no longer clones the bytes via `Buffer.from(typedArray)`; the runtime wraps the same `ArrayBuffer` with `Buffer.from(buffer, byteOffset, byteLength)`. `Buffer` inputs are forwarded as-is.
- **Allocation-free `game-sync` tick** — `collectActiveObjectIdsInto` fills a reusable `Int32Array`; `simulateWorldStep` accepts any `ArrayLike<number>` plus a `count` (plain arrays still work). Tick bodies are stable module functions; `dt` is measured when the step runs inside the mutation chain, not when it is scheduled. `game-sync` / `redis-sync` broadcast via one `broadCastBinaryToClients` call over a live session array.
- **`redis-sync` binary inbound** — clients send a 12-byte `Float32Array([clientIndex, x, y])` on `voicethere-sync`; `onDataChannelBinary` patches Redis slots. JSON `{ type: "position" }` is no longer accepted.

- **Breaking (0.x):** template source paths. `templates/echo.ts` is now `templates/echo/agent.ts`; `templates/game-sync.ts` is `templates/game-sync/agent.ts`; `templates/agent.ts` is `templates/voice-starter/agent.ts`. Update local `build --entry` flags and GitHub permalinks.

## [0.7.13] - 2026-09-19

### Added

- **`spatial-showcase` orbit** — per-session sine frequency, start/stop playback vs orbit cycle, drag-to-place (`orbit` `action: "place"`), gapless clip restart, and `orbit_say_status` while TTS plays (voicethere/agent#90).
- **`spatial-showcase` soundboard** — `pad_move` repositions an active play via `setPlayPose` (voicethere/agent#91).

## [0.7.12] - 2026-09-17

### Added

- **`setPlayPose`** — world pose for an active clip play (`PlayPoseMessage` IPC; `PlayPoseResult` ack).
- **`spatial-showcase` orbit demo** — looping 440 Hz sine via `play` + `setPlayPose`; greeting and Say-it TTS via `setTtsPose`; STT echo off on orbit join (voicethere/agent#87). Requires `@node-webrtc-rust/helpers` **0.9.9** (`setPlayPose`, no mix drain on pose updates).

### Fixed

- **`spatial-showcase` soundboard pads** — pad acks include `clipId`, `x`, and `z`; loop replay re-acks on restart; stop same-clip loop before `MAX_ACTIVE_PLAYS` (12); invalid `clipId` rejected (voicethere/agent#88).

### Changed

- **Dev deps** — `@node-webrtc-rust/{helpers,sdk,signaling}` **0.9.9**.

## [0.7.11] - 2026-09-15

### Fixed

- **`spatial-showcase` template** — emit first `orbit_pose` and proximity `room_state` before greeting `speak()` so clients can apply spatial pose on the first TTS chunk (voicethere/agent#85).

## [0.7.10] - 2026-09-14

### Added

- **`spatial-showcase` template** — one Voice+Data product template for landing `/showcase` demos. A `{ type: "join", demo }` DataChannel message selects `orbit` (per-listener TTS pose), `soundboard` (positional clips by `clipId` only; agent resolves allowlisted `assetOrigin`), or `proximity` (mix group + `setClientPose`). Caps: 8 room peers, 4 concurrent plays per session.

## [0.7.9] - 2026-09-13

### Fixed

- **`echo-smoke` / `crash` templates** — TTS reply prefix `Okay.` instead of `echo.` (local STT emits no token for ~5% of Piper `echo.` renders; audio was intact).

## [0.7.8] - 2026-09-11

### Fixed

- **`game-sync` Redis world blob** — use ioredis `set` (not `setBuffer`) for binary world writes so dashboard `code-compile-smoke` typechecks against ioredis 5.11 types.

## [0.7.7] - 2026-09-11

### Added

- Template npm `package.json` for dashboard/CLI workspaces (`loadTemplateProjectWorkspace`, `buildCustomerPackageJson`); image-provided dependency strip helper (`stripImageProvidedNpmDependencies`).

### Fixed

- **`echo-smoke` template** — keep `echo. ${text}` (sentence boundary before echoed phrase). Hang-up language ID no longer runs a second Whisper job, so dotted TTS is safe again.

## [0.7.6] - 2026-09-10

### Fixed

- **`echo-smoke` and `crash` templates** — speak `echo. ${text}` instead of `echo:${text}` so Piper gets a sentence boundary before the echoed phrase (fixes voice-smoke prefix miss when `echo:One` skipped "echo colon").

## [0.7.5] - 2026-09-10

### Changed

- **`mix-smoke` DataChannel `play`** — trigger only; the template generates a loud 2s inline WAV (optional `bytes` / `url` still override). Avoids oversized SCTP messages when e2e clients used to send the clip on `voice-control`.

## [0.7.4] - 2026-09-09

### Added

- **`onUserLanguage`** — convenience handler for spoken-language identification (`user_language` speech events; ISO 639-1).

### Changed

- **Peer dependency** — `@node-webrtc-rust/sdk` `>=0.9.0` (spoken language identification / `user_language`).

## [0.7.3] - 2026-09-09

### Added

- **Clip playback APIs** — `play`, `getPlay`, and `stopPlay` (`PlayMessage` IPC; HTTPS URL or small inline `bytes`; optional `sessionIds`, `volume`, `placement` / `pose`).
- **`setTtsPosition`** — MixPlacement or world pose for TTS (passthrough to the runner).
- **`mix-smoke` DataChannel `play`** — inline clip fixture for voice-data-mix-smoke one-listener vs all-target probes.

### Changed

- **Dev deps** — `@node-webrtc-rust/{helpers,sdk,signaling}` **0.9.0** (native ClipPlayer / `playAudio`).

## [0.7.2] - 2026-09-07

### Added

- **`mix-smoke` TTS pan DataChannel actions** — `set_tts_pose`, `speak`, and `clear_tts_pose` for E2E positional TTS energy probes (pan vs the listener session id).

## [0.7.1] - 2026-09-07

### Added

- **Mix mute APIs** — `setGlobalMute`, `setListenerMute`, and `getClientMixStatus` (`MixControlMessage` IPC, `MixControlResult` acks; `get_status` acks may include optional `statuses`).
- **`mix-smoke` DataChannel actions** — `set_global_mute`, `set_listener_mute`, and `get_status` for E2E positional-mix mute smoke tests.

## [0.7.0] - 2026-09-03

### Added

- **Mix group APIs** — `createMixGroup`, `addClientToMix`, `removeClientFromMix`, `setPositionalMixing`, `setDefaultMixPlacement`, `setTtsMixPlacement`, and `setClientPose` for Voice+Data sessions (`mixAvailable` on `session_start`). Gated by `isMixAvailable(ctx)`.
- **`setTtsPose` / `clearTtsPose`** — positional TTS orbit per session (`ttsPoseAvailable` on `session_start`); `isTtsPoseAvailable(ctx)` helper.
- **`setSttEnabled`** — toggle STT for one client or all agents in a session (`SttControlMessage` IPC).
- **`positional-tts` product template** — orbiting speaker demo using TTS pose APIs.
- **`mix-smoke` E2E template** — DataChannel commands for positional mix smoke tests (Voice+Data, shared child).

### Changed

- **Dev deps** — `@node-webrtc-rust/{helpers,sdk,signaling}` **0.8.0** (mix graph, `setTtsPose`, `setSttEnabled` in live-test stack).

## [0.6.0] - 2026-09-01

### Added

- **`loadTemplateWorkspaceSources`** — template sources with registry `sourceFiles` paths preserved (e.g. `voice-showcase/agent.ts`, `redis-sync/world-layout.ts`).
- **`@voicethere/agent/build`** — exports `buildAgentBundle` and `BuildAgentBundleOptions` for dashboard workspace bundling.

### Changed

- **`voice-showcase` TTS order** — send spoken text to the client (`chat_reply` / menu) first, then trigger TTS play (`speak`). Greeting and later turns no longer start playback before the client has the utterance.

### Fixed

- **`game-sync` join snapshot** — `world_snapshot` lists live Redis/world slots via `collectActiveObjectIds`, not in-process `objectOwners` only; join hydrates from Redis when enabled.
- **`game-sync` Redis sim tick** — lock holder runs one GET, simulate with clamped real dt, one SET, and broadcasts that buffer (no second GET or `commitSimulatedWorld` in the tick).
- **`game-sync` lock-miss relay** — when the sim lock is busy but clients are connected, one GET plus broadcast instead of trailing GET on every tick.

## [0.5.6] - 2026-08-31

### Added

- **`recording-consent` product template** — consent on session connect, pause for name/birthdate, resume only if consented and recording available; skip consent + warn when project recording is off.
- **`startRecording` / `resumeRecording` deny** — when session `recordingAvailable` is false, return `{ ok: false, reason: "disabled" }` and warn; agent cannot turn recording on.

## [0.5.5] - 2026-08-30

### Fixed

- **`game-sync` remove by `objectId`** — `{ type: "remove" | "unregister", objectId }` targets that slot on the public board (no session-owner check). Lua release failure nacks (`not_found`).
- **`game-sync` Redis persist** — sim tick uses a second GET plus `preserveEmptySlots` so a concurrent Lua release is not overwritten. World keeps simulating with zero connected clients; leave no longer Lua-releases owned slots.
- **ioredis sandbox CI flake** — mini-redis mock now parses complete RESP commands (pipelined HELLO+PING no longer desyncs ioredis). Probe child is killed on timeout so `afterEach` cannot hang on `server.close()`.
- **`voice-showcase` weather** — country-only replies (e.g. “Thailand”) no longer overwrite a stored city/ZIP, so the agent does not loop on “Which country is that in?”. Spoken ZIP digits plus a trailing country name parse in one utterance.

## [0.5.4] - 2026-08-28

### Added

- **`voice-showcase` product template** — conversational demo (greeting, name, menu: weather via Open-Meteo, count 1–10, recipes, fun facts). Pure `conversation.ts` state machine for unit tests; `seedOnCreate` prebuilt bundle at `dist/templates/voice-showcase/agent.js`.
- **`game-sync` world cap** — max **25** live objects; `register_nack` with `reason: "world_full"`. `{ type: "unregister" }` / `{ type: "remove" }` control messages with ack/nack. Protocol parsers extracted to `game-sync-protocol.ts`.
- **`game-sync` Redis world sync** — when `AGENT_REDIS_URL` is set, the world buffer (`game-sync:world`) is shared across runner workers with Lua atomic allocate/release and a sim lock; cap and unregister behavior unchanged. Falls back to in-memory world when Redis is unset.

## [0.5.3] - 2026-08-26

### Added

- **`game-sync-smoke` `env_probe`** — data-channel message `{ type: "env_probe", key }` returns `{ type: "env_probe_ack", key, value }` for allowlisted `AGENT_E2E_*` keys only (reads `process.env`; rejects webhook/OpenAI and other secrets).

## [0.5.2] - 2026-08-26

### Added

- **`sessionIds` on webhook IPC** — optional `WebhookMessage.sessionIds` and `WebhookContext.sessionIds` so the runner can pass live orchestrator session ids (parent is source of truth). `webhooks` / `webhooks-redis` templates prefer `ctx.sessionIds` over in-child `connectedSessions`.

### Fixed

- **Webhook template HMAC** — signature header lookup is case-insensitive (`X-Agent-Webhook-Signature` and variants).

## [0.5.1] - 2026-08-26

### Fixed

- **`verify`** — accept `onWebhook` and `onSessionStart` as sufficient handlers so webhook-only and session-start-only agents pass local verify (no dummy DataChannel handler required).

## [0.5.0] - 2026-08-25

### Added

- **`onWebhook`** — process-wide inbound HTTP webhook handler (`WebhookMessage` / `WebhookContext`). The runtime delivers the **raw body** as a `Buffer` plus inbound headers so you can verify HMAC (or any signature) **before** `JSON.parse`.
- **`webhooks` template** — verifies `x-agent-webhook-signature` (hex HMAC-SHA256 of the raw body) using `AGENT_WEBHOOK_SIGNING_SECRET`, then broadcasts `webhook_event` to connected sessions.
- **`webhooks-redis` template** — same verification, with project Redis for cross-pod session fan-out.
- **`webhook_handled` IPC** — child reports handler duration after `onWebhook` completes (parent metrics).

## [0.4.0] - 2026-08-23

### Added

- **Conversation recording controls** — `startRecording`, `pauseRecording`, `resumeRecording`, and `stopRecording` (`RecordingControlMessage` IPC) return `Promise<RecordingControlResult>` and await a parent `recording_control_ack` (`requestId` correlation).
- **`recordingAvailable` on `session_start`** — runner advertises when conversation recording is enabled for the project; exposed on `SessionContext` (defaults to `false` on older runners).
- **`local_mock` fast path** — when the agent is not a forked IPC child, recording helpers resolve immediately with `{ ok: true, reason: "local_mock" }` so local verify runs never block on a parent ACK.
- **`isRecordingAvailable(ctx)`** helper for consent gating before `startRecording`.

## [0.3.0] - 2026-08-02

### Added

- **`@voicethere/agent/templates`** — registry API (`listTemplates`, `getTemplate`, `resolveTemplateEntryPath`, `loadTemplateSources`, `loadTemplateBundle`, `hasSeedBundle`).
- Product seed-on-create templates with prebuilt `dist/templates/<id>/agent.js`: `echo`, `echo-dc`, `voice-starter`, `game-sync`.
- E2E template sources: `echo-smoke`, `crash`, `game-sync-smoke`, `redis-sync` (+ `./templates/redis-sync/world-layout` export).

## [0.2.17] - 2026-07-31

### Changed

- **Deps** — `@node-webrtc-rust/{helpers,sdk,signaling}` **0.7.0** (Opus SDP omits `maxaveragebitrate` unless env set; encode default 400 kbps).

## [0.2.16] - 2026-07-30

### Changed

- Bump `@node-webrtc-rust/{helpers,sdk,signaling}` to **0.6.24**.
- Sync Sherpa STT/TTS catalogs used by live-test model selection scripts.

## [0.2.15] - 2026-07-29

### Changed

- Bump `@node-webrtc-rust/{helpers,sdk,signaling}` to **0.6.21** (VoiceAgentSessionHost waits for voice-control DataChannel open before starting VoiceAgent).

## [0.2.14] - 2026-07-28

### Fixed

- **`SessionSerialQueue`** — keep the per-session row while connected (`pending === 0` no longer deletes it). Idle-delete made `isLive` false between inbound handlers and silently dropped timer/`sendBinaryToClient` fan-out (redis-sync world broadcast). Rows are removed only by `clear` (`session_end`); the leave-hook generation is cleared after the end handler finishes.
- **Outbound guards** — detached sends again require a registered live session that has not received `session_end` (not “a handler is currently running”).

## [0.2.13] - 2026-07-28

### Fixed

- **`SessionSerialQueue`** — generation-safe clear/reuse so stale handlers cannot mutate a later session generation; no per-session tombstone maps left at idle.
- **`session_end`** — invalidate/abort the live queue immediately on message arrival, then process end on a fresh generation.
- **Outbound guards** — generation-aware execution context blocks speak/send after clear or reuse.

## [0.2.12] - 2026-07-25

### Fixed

- **`SessionSerialQueue`** — task rejections are contained at the queue tail so they do not surface as process `unhandledRejection` events; pending state clears and later same-session tasks still run.
- **`defineAgent`** — installs a once-per-process `unhandledRejection` guard for detached customer promises, reporting a single `agent_error` (with active session id when AsyncLocalStorage context is available). Awaited handler failures remain reported only by the existing try/catch path. Does not install a non-fatal `uncaughtException` listener.

## [0.2.11] - 2026-07-20

### Added

- **Structured `agentLog`** — levels `debug|info|warn|error`, optional `fields` JSON, and `ts` on IPC `{ type: "log" }` payloads (backward-compatible sessionId argument).
- **Sandbox console overrides** — `console.debug/log/info/warn/error` send structured log IPC (object first-arg with `message`/`fields` supported).

## [0.2.10] - 2026-07-17

### Fixed

- **Sandbox IPC** — `startSandboxedChild` now forks with `serialization: "advanced"` so `sendBinaryToClient` payloads remain real `Buffer`s across parent/child IPC (default JSON serialization turned them into `{ type: "Buffer", data: [...] }` and broke WebRTC binary fan-out).

## [0.2.9] - 2026-07-17

### Changed

- **Node 26+** — CI, `engines`, and `verify` require Node **26+** because sandbox `--allow-net` is only enforced on Node 26. Runner images use Node 26 as well.
- **Sandbox network** — `buildChildExecArgv` always emits boolean `--allow-net` (opt out with `allowInternet: false`) so customer agents can `fetch` LLM APIs under `--permission`.

### Added

- **`test/fetch-sandbox.test.ts`** — sandboxed child can `fetch` `https://www.google.com/` with production execArgv flags.
- **`test/ioredis-bundle-sandbox.test.ts`** — builds an `ioredis` agent bundle and verifies `onAgentStart` can PING Redis under production sandbox flags.

### Fixed

- **`build` / `buildAgentBundle`** — bundle banner injects `createRequire` so inlined CJS deps (e.g. `ioredis`) can load Node built-ins (`events`, `net`, `stream`) without `Dynamic require of "events" is not supported`; stubs optional `supports-color` so debug code does not escape the sandbox fs allowlist.

## [0.2.8] - 2026-07-17

### Added

- **`onAgentStart`** — optional one-shot hook on `defineAgent` that runs before any session IPC is handled. Use it to open process-wide resources (for example an `ioredis` client via `process.env.AGENT_REDIS_URL` / `ctx.env.AGENT_REDIS_URL`). Errors are logged and reported as `agent_error`; session IPC is still accepted afterward so the child does not hang.
- **Sandbox `allowNetHosts`** — `buildChildExecArgv({ allowNetHosts })` emits scoped `--allow-net=<host>` flags so sandboxed children can reach project Redis while still denying `child_process`, fs writes, and addons.

### Docs

- Prefer depending on **`ioredis`** in your agent bundle and connecting inside `onAgentStart` when VoiceThere injects `AGENT_REDIS_URL`.

## [0.2.7] - 2026-07-17

### Changed

- **Dev tooling** — align `@node-webrtc-rust/helpers` to `^0.6.10` and matching `sdk` / `signaling` `0.6.9` for live-test `SessionPod` typing (no published runtime API change).

## [0.2.6] - 2026-07-13

### Fixed

- **`onIdleTimeout` TypeScript narrowing** — bind optional handler to a local before `await` so `tsc` accepts the call after the early-return path.

### Added

- **Idle timeout IPC logging** — `agentLog` lines when `idle_timeout` is received and when `idle_timeout_done` is sent (visible in runner Loki as `source: agent-child`).

## [0.2.5] - 2026-07-13

### Fixed

- **Idle timeout without `onIdleTimeout`** — when the agent bundle does not define `onIdleTimeout`, the child now sends `idle_timeout_done` immediately instead of going through the hook path (avoids an extra runner callback grace wait when no customer handler exists).

## [0.2.4] - 2026-06-30

### Added

- **`verify-start` command** — new `npx @voicethere/agent verify-start` runs a sandbox startup check that launches the bundle in the restricted child process, validates sandbox permission flags, and requires `session_start_ack`.

## [0.2.3] - 2026-06-30

### Changed

- **Static-only bundle verification** — `npx @voicethere/agent verify` no longer executes or imports customer bundle code; verification now performs static checks only.
- **Verification callback criteria** — replaced the `speak()` runtime requirement with callback coverage checks; bundles pass when they register `defineAgent(...)` and define at least one of: `onSpeechEvent`, `onUserSpeechFinal`, `onDataChannelMessage`, `onDataChannelBinary`.
- **Game/data-only compatibility** — game-only servers without `speak()` usage now pass verification when valid callback handlers are present.

## [0.2.2] - 2026-06-28

### Added

- **Configurable session start init delay** — runtime now supports `AGENT_SESSION_START_INIT_DELAY_ENABLED` (default `true`) and `AGENT_SESSION_START_INIT_DELAY_MS` (default `500`) to control startup stabilization wait before `onSessionStart`.
- **Runner export for queue utility** — `SessionSerialQueue` is now exported from `@voicethere/agent/runner`.
- **Queue pending-state API** — added `SessionSerialQueue.hasPending(sessionId)` for per-session queue state checks.

### Changed

- **Runtime tests** — added coverage for default/custom/disabled session-start delay behavior.

## [0.2.1] - 2026-06-28

### Added

- **Server-authoritative game live test page** — added `examples/live-test/game-sync.html` with room bootstrap, binary world render, per-client ownership colors, and incoming server sync-rate metrics.
- **Dedicated game stack command** — added `live-test:stack:game` for one-command data-only runs using `templates/game-sync.ts` and the game page.

### Changed

- **`templates/game-sync.ts` behavior** — switched to server-authoritative 60Hz simulation with wall/object collision bounce; client binary state writes are ignored by default.
- **Game template docs** — expanded `templates/README.md` and root/live-test docs to describe server-authoritative sync flow and usage.
- **Live-test binary robustness** — improved starter/runtime handling for binary payload forwarding across IPC/DataChannel boundaries.

## [0.2.0] - 2026-06-28

### Added

- **Standalone local live-test stack in `agent`** — added a self-contained starter and browser page (`scripts/live-test-starter.*`, `examples/live-test`) to run signaling + sandboxed agent bundle locally without runner-repo coupling.
- **Public runner runtime surface** — added `@voicethere/agent/runner` export and runtime entry (`src/runner.ts`) for shared sandbox child startup and bundle resolution logic.
- **Sherpa local model tooling in `agent`** — added standalone model catalogs (`scripts/sherpa-*.json`) and interactive selector (`scripts/select-sherpa-models.sh`) that downloads models into `agent/.models` and writes live-test env settings.

### Changed

- **Live-test scripts and docs** — moved local live testing to agent-only workflows (`live-test:starter`, `live-test:stack`), updated README/live-test docs, and added `.env.live-test.example`.
- **Protocol/runtime ergonomics** — re-exported `SpeechEvent` from `protocol.ts` for consistent type imports from `@voicethere/agent`.

## [0.1.14] - 2026-06-28

### Added

- **`agentLog` session context** — `sessionId` is now automatically attached to `AgentLogMessage` IPC; the runtime injects the active orchestrator session from handler context so `agentLog(level, message)` keeps its two-arg signature.

### Changed

- **Peer dependency** — `@node-webrtc-rust/sdk` `>=0.6.5` (aligns with latest SDK release).

## [0.1.13] - 2026-06-23

### Fixed

- **`speak()` after `session_end`** — no-op when the session is already ended (avoids errors from late TTS in teardown races).

### Changed

- **Peer dependency** — `@node-webrtc-rust/sdk` `>=0.6.2` (aligns with inbound STT finalize and post-utterance silence).

## [0.1.12] - 2026-06-20

### Added

- **`session_start_ack` IPC** — child confirms `session_start` handling completed so the parent can gate `speech_event` / data-channel messages until startup finishes.

### Fixed

- **Session serial queue tail cleanup** — compare the settled promise when removing per-session queue tails (avoids stale tail references under overlapping handlers).

## [0.1.11] - 2026-06-20

### Fixed

- **Shared child IPC ordering** — `defineAgent` serializes inbound parent messages per `sessionId` (FIFO) so `session_start` handlers (e.g. greet `speak`) complete before `session_end` for the same session under `shared_child_per_session` load.

## [0.1.10] - 2026-06-18

### Fixed

- **Sandbox bundle path** — `realpathSync` on bundle file for ESM `import()` under Node `--permission`; allowlist includes canonical bundle path (parity with runner child fork).

## [0.1.9] - 2026-06-16

### Fixed

- **`package.json` exports** — add `default` and `require` conditions for `.` and `./verify` so Node/tsx CJS resolution works (fixes `ERR_PACKAGE_PATH_NOT_EXPORTED` in platform workers and scripts).

## [0.1.8] - 2026-06-16

### Added

- Binary DataChannel IPC: `data_channel_binary` (parent→child) and `send_binary_to_client` (child→parent).
- `DataChannelContext.rawBinary`, optional `raw`, and `channel` (`control` | `sync`).
- `sendBinaryToClient(sessionId, data, channel?)` helper.

### Changed

- Peer dependency `@node-webrtc-rust/sdk` **>=0.5.4** (ArrayBuffer send/receive on data channels).

## [0.1.7] - 2026-06-15

### Added

- **`templates/echo.ts`** — full echo agent: TTS **"you said: …"** on voice finals and typed chat, plus DataChannel speech events and `chat_reply` (for platform **Echo (voice + chat)** template).
- **`AGENT_ECHO_PREFIX`** env override for the spoken/chat prefix (default `you said:`).

### Changed

- **`templates/README.md`** — documents `echo.ts` vs `echo-dc.ts`.

## [0.1.6] - 2026-06-15

### Added

- **`sendToClient(sessionId, payload)`** — send JSON to the browser over DataChannel from agent handlers.
- **`onDataChannelMessage`** handler on `defineAgent` for inbound client messages.
- **`templates/echo-dc.ts`** — starter template that echoes DataChannel chat (for dashboard debug chat).

## [0.1.5] - 2026-06-15

### Changed

- MIT license (A KIRILYUK LLC)

## [0.1.4] - 2026-06-09

### Added

- `./verify` package export — `runAgentVerify` for server-side bundle validation (`@voicethere/agent/verify`)

### Changed

- `@node-webrtc-rust/sdk` is **peerDependency only** (removed from `dependencies`) so consumers like the platform control plane can install verify without pulling native WebRTC bindings

## [0.1.3] - 2026-06-09

### Added

- `npx @voicethere/agent verify` — build (optional) and run sandbox checks on customer bundles; prints failing checks with details

### Changed

- CLI shows help when invoked with no subcommand (explicit `build` or `verify` required)
- Sandbox verify harness ships in the npm package (`src/sandbox`, `src/verify`)

## [0.1.2] - 2026-06-09

### Added

- `npx @voicethere/agent build` — bundle customer `agent.ts` to `dist/agent.js` (esbuild included; no separate devDependency)

## [0.1.1] - 2026-06-09

### Changed

- README and customer-facing docs: replace public runner repo links with VoiceThere agent runner (platform or internal deployment)
- Sandbox documentation: clarify that `fetch` / HTTP(S) to public APIs is supported on hosted sessions; trim internal infra details

## [0.1.0] - 2026-06-09

### Added

- Initial `@voicethere/agent` SDK: IPC protocol, `defineAgent`, `speak`, `agentLog`
- Re-exported `SpeechEvent` types from `@node-webrtc-rust/sdk/voice`
- `onSpeechEvent` handler and starter template covering all 14 `SpeechEvent` types
- Speech event IPC (`speech_event.event` with SDK `SpeechEvent` shapes)
- Local sandbox verify harness (`npm run verify:local`) aligned with runner child launcher
- Example bundle (`dist/agent.js`) and [`templates/agent.ts`](./templates/agent.ts)
- npm release workflow (`release/*` tags) — see [`scripts/RELEASE.md`](./scripts/RELEASE.md)
