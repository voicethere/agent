# speaker-gate

A phone on a table picks up everyone in the room. The speaker gate learns the first voice of the call, the caller's, and then tells that voice apart from the rest. This template shows the three modes and how to switch between them while the call is running.

The project's voice settings pick the mode the call starts in (`speakerGate.mode`). Details and the full settings list are on the docs page at `/docs/speaker-gate`.

## Modes

| Mode       | What reaches the agent                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `disabled` | Every final. No speaker fields.                                                                                                |
| `auto`     | Only the enrolled caller's finals, as a normal `onUserSpeechFinal`. A bystander arrives as `onUserSpeechIgnored` with no text. |
| `manual`   | Every final, with `speaker` set to `caller`, `other` or `unknown`. The agent decides what to do.                               |

`speakerUnknownReason`, `speakerCheckWindows` and `speakerRechecked` come along when the runner sets them. A separate `bargeIn` policy says who may interrupt the agent: `caller_only` (default) or `anyone`.

## What the template does

- In `manual` it answers `caller` and `unknown` finals. When it hears `other` it says one short line, at most once every 30 seconds, and otherwise stays quiet.
- Every event writes one agent log line with a counter `n` that starts at 1 and counts all lines of the session:
  - `speaker_gate.mode n=1 mode=auto` at connect and after each applied mode command;
  - `speaker_gate.final n=2 speaker=caller|other|unknown|none utteranceId=<id> reason=<reason> text="..."` for every final (`none` when the event has no verdict; `utteranceId` and `reason`, the speaker unknown reason such as `not_enrolled`, appear only when the runner sets them, and `text` is always last). This line includes the transcript, so treat these logs as call content;
  - `speaker_gate.ignored n=3 utteranceId=<id> reason=speaker_mismatch` for each utterance `auto` mode drops;
  - `speaker_gate.reset n=4` after an enrollment reset.
- A bystander's voice cannot change the mode: spoken commands are ignored when the verdict is `other`.

The mode you request and the mode in effect can differ. If the speaker model fails to load, the runner switches the gate to `disabled` and tells the agent once; `getSpeakerGate(sessionId)` then returns `mode: "disabled"`. A pending `setSpeakerGate` or `resetSpeakerEnrollment` call resolves `{ ok: false, reason: "session_ended" }` as soon as the session ends.

## Switching the mode

Send a data-channel chat message, `{ "type": "chat", "text": "speaker-gate:auto" }`:

| Text                    | Effect                                                      |
| ----------------------- | ----------------------------------------------------------- |
| `speaker-gate:auto`     | `setSpeakerGate(sessionId, { mode: "auto" })`               |
| `speaker-gate:manual`   | `setSpeakerGate(sessionId, { mode: "manual" })`             |
| `speaker-gate:disabled` | `setSpeakerGate(sessionId, { mode: "disabled" })`           |
| `speaker-gate:reset`    | `resetSpeakerEnrollment(sessionId)`: learn the caller again |

Or say it: "only listen to me" switches to `auto`, "listen to everyone" switches to `manual`.

A switch applies from the next utterance. The enrolled caller is kept across switches, so going from `auto` to `disabled` and back does not enroll again.

## When the gate is not available

`ctx.speakerGate.available` is `false` on older runners and on nodes without the speaker model. `setSpeakerGate` and `resetSpeakerEnrollment` then resolve `{ ok: false, reason: "not_available" }` and the agent hears every voice, as in `disabled`.

## Sources

- `agent.ts` (`templates/speaker-gate/agent.ts`)
