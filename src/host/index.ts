export {
  SessionSpeakController,
  type SessionSpeakControllerDeps,
  type SessionSpeakControllerOptions,
} from "./session-speak-controller.js";
export { DEFAULT_CHARS_PER_MS, estimatePlayedText } from "./speak-text.js";
export type {
  AgentInterruptedMessage,
  SpeakMessage,
  SpeakResultMessage,
  SpeakCancelMessage,
  SpeakStatus,
  BargeInControlMessage,
  BargeInControlAckMessage,
} from "../protocol.js";
