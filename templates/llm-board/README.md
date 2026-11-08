# llm-board

A shared brainstorming board with an LLM facilitator. People add sticky notes from the browser; the facilitator reads, adds and edits notes by voice or chat through three tools. Source: `templates/llm-board/agent.ts`.

## What you need

A project secret named `AGENT_OPENROUTER_API_KEY` (a key from openrouter.ai). No Redis: the board lives in the agent process for the length of the session and is dropped when the session ends.

## Files

- `agent.ts` routes board messages first and passes everything else to the LLM as chat. It also defines the tools `list_notes`, `add_note` and `update_note`.
- `board.ts` is the board itself and the message parser, with no VoiceThere imports.
- `voicethere.llm.json` holds the model (`amazon/nova-micro-v1` on OpenRouter), greeting and settings. Knowledge is off.
- `prompt.md` is the facilitator's system prompt.
- `md.d.ts` lets TypeScript accept `import x from "./x.md"`.

## Message protocol

Data channel messages from the client:

| Message                                                          | Effect                         |
| ---------------------------------------------------------------- | ------------------------------ |
| `{ "type": "note.add", "text", "x"?, "y"?, "color"? }`           | Adds a note with author `user` |
| `{ "type": "note.update", "id", "text"?, "x"?, "y"?, "color"? }` | Changes the given fields       |
| `{ "type": "note.remove", "id" }`                                | Deletes the note               |
| `{ "type": "board.sync" }`                                       | Sends the current board        |

The agent answers every change, and every `board.sync`, with `{ "type": "board", "notes": Note[] }` to the session.

A note is `{ id, text, x, y, color, author }`:

- `text`: 1 to 200 characters.
- `x`, `y`: 0 to 1, from the top left corner. Without them a new note takes a free spot on a grid.
- `color`: `yellow` (default), `blue`, `green` or `pink`.
- `author`: `user` or `ai`.

The board holds at most 60 notes. A message that fails validation (a 201 character text, a coordinate outside 0 to 1, an unknown id) changes nothing, and the board is sent back unchanged. Chat messages `{ "type": "chat", "text" }` go to the LLM as before.

## Cost

Measured on VoiceThere's demo: see the use-case page.
