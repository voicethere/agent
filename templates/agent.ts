/**
 * Starter template — copy into your project and build to a single `agent.js` bundle.
 */

import { defineAgent, speak } from '@voicethere/agent'

defineAgent({
  onSessionStart({ sessionId }) {
    speak(sessionId, 'Hello! How can I help?')
  },

  onUserSpeechFinal({ sessionId, text }) {
    speak(sessionId, `You said: ${text}`)
  },
})
