/**
 * Guidance for the system prompt of an agent that answers phone calls. Append
 * it to your prompt (it is never added automatically):
 * `systemPrompt: `${prompt}\n\n${CALL_AGENT_PROMPT_GUIDANCE}``.
 */
export const CALL_AGENT_PROMPT_GUIDANCE = `## Voice call

You are on a live phone call. Always answer right away; never leave the caller in silence.

Keep sentences short; one idea per sentence. No lists, no markdown, no emojis; say numbers and dates the way a person would.

If you cannot help, say so in one sentence and offer what you can do.`;
