/**
 * IPC message shapes between trusted runner parent and isolated customer child.
 *
 * Keep in sync with `runner/src/child/protocol.ts`.
 */

export type ParentToChildMessage =
  | { type: 'session_start'; sessionId: string; env: Record<string, string> }
  | { type: 'user_speech_final'; sessionId: string; text: string }
  | { type: 'session_end'; sessionId: string }

export type ChildToParentMessage =
  | { type: 'speak'; sessionId: string; text: string }
  | { type: 'log'; level: 'info' | 'error'; message: string }
  | { type: 'agent_error'; sessionId: string; message: string }

export const ALLOWED_CHILD_ENV_KEYS = ['SESSION_ID', 'PROJECT_ID', 'BUILD_ID'] as const
