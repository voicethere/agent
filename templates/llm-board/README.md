# llm-board

A shared brainstorming board with an LLM facilitator. People add sticky notes from the browser; the facilitator reads, adds and edits notes by voice or chat through three tools. Source: `templates/llm-board/agent.ts`.

## What you need

A project secret named `AGENT_OPENROUTER_API_KEY` (a key from openrouter.ai). No Redis: boards live in the agent process and are deleted when the last session in the room ends.

## Files

- `agent.ts` routes board messages first and passes everything else to the LLM as chat. It also defines the tools `list_notes`, `add_note` and `update_note`.
- `board.ts` is the board itself and the message parser, with no VoiceThere imports.
- `voicethere.llm.json` holds the model (`amazon/nova-micro-v1` on OpenRouter), greeting and settings. Knowledge is off.
- `prompt.md` is the facilitator's system prompt.
- `md.d.ts` lets TypeScript accept `import x from "./x.md"`.

## Message protocol

Data channel messages from the client:

| Message                                                          | Effect                                                                      |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `{ "type": "note.add", "text", "x"?, "y"?, "color"? }`           | Adds a note with author `user`                                              |
| `{ "type": "note.update", "id", "text"?, "x"?, "y"?, "color"? }` | Changes the given fields                                                    |
| `{ "type": "note.remove", "id" }`                                | Deletes the note                                                            |
| `{ "type": "board.join", "room" }`                               | Joins a room (`a-z`, `0-9`, `-`, 6 to 40 characters) and leaves the old one |
| `{ "type": "board.sync" }`                                       | Sends the current board to the requester only                               |

One agent process serves many sessions, so boards are scoped to rooms. A session that never sends `board.join` has a private board. Sessions that join the same room share one board and one set of notes, and the facilitator's tools read and change the board of the room the session is in. Anyone who knows a room id can join it, so use a long random id for a private room.

The agent answers every change with `{ "type": "board", "notes": Note[] }` to every session in the room. A `board.sync` is answered to the requester only.

A note is `{ id, text, x, y, color, author }`:

- `text`: 1 to 200 characters.
- `x`, `y`: 0 to 1, from the top left corner. Without them a new note takes a free spot on a grid.
- `color`: `yellow` (default), `blue`, `green` or `pink`.
- `author`: `user` or `ai`.

The board holds at most 60 notes. A message that fails validation (a 201 character text, a coordinate outside 0 to 1, an unknown id) changes nothing, and the board is sent back unchanged. Chat messages `{ "type": "chat", "text" }` go to the LLM as before.

## Cost

Measured on VoiceThere's demo: see the use-case page.
