/**
 * Default echo agent bundle — built to `dist/agent.js` for local runner dev.
 *
 *   cd agent && npm run build
 *   cd ../runner && AGENT_BUNDLE_PATH=../agent/dist/agent.js npm run start
 */

import { defineAgent, speak } from '../src/runtime.js'

defineAgent({
  onUserSpeechFinal({ sessionId, text }) {
    speak(sessionId, `You said: ${text}`)
  },
})
