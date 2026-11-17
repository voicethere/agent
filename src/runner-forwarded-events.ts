/**
 * Speech event types the cloud runner delivers to a customer agent in
 * `speech_event`. Other `SpeechEvent` types (partials, VAD, `stt_stream_*`,
 * `user_stt_*`, `user_speaking_*`) stay in the runner and never reach the agent.
 */
export const RUNNER_FORWARDED_SPEECH_EVENTS = [
  "user_speech_final",
  "user_speech_ignored",
  "user_utterance_split",
  "user_language",
  "agent_speaking_start",
  "agent_speaking_end",
  "tts_wait",
  "agent_speak_failed",
  "tts_phrase_cache_hit",
  "speaker_gate_ready",
  "barge_in",
] as const;
