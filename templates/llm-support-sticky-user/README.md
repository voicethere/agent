# llm-support-sticky-user

A support agent that remembers its callers. It is the `llm-agent` template plus end-user identity: when your app tells VoiceThere who the user is, the agent can read and update that user's tickets in your CRM, and it picks up where the last conversation stopped. Source: `templates/llm-support-sticky-user/agent.ts`.

What it does:

- The four ticket tools (`get_open_tickets`, `get_ticket`, `add_troubleshooting_step`, `create_ticket`) use `requiresVerifiedUser`. The model does not see them, and a forced call is refused, until the session has a verified user.
- The tools never take a user id. They use `ctx.user.id` from the session, so a caller who says "I am user 456" gets nothing from another account.
- When a verified user is present at session start, or logs in mid-call (`onUserIdentified`), `hooks.ts` loads their open tickets and the last three conversations (`getUserHistory`) into the model's context. Mid-call, the agent also says a short confirmation. If history is `unverified`, `disabled` or `unavailable`, the agent carries on without it.
- Steps recorded with `add_troubleshooting_step` are written to the CRM when the call ends (`onSessionEnd`), for the user who recorded them only.
- Logs carry ids and error names only, never what was said.

## Run it locally

Without a CRM URL the agent uses `mock-crm.ts`: one user, `demo-user`, with an open ticket and two steps already tried. Edit it to try your own cases.

## Connect your CRM

Add project secrets (only names starting with `AGENT_` reach the agent):

- `AGENT_CRM_API_URL`: base URL of your CRM
- `AGENT_CRM_API_KEY`: sent as `Authorization: Bearer <key>`

`CRM_API_URL` and `CRM_API_KEY` work for local runs. Every request has a 3 second limit. `tools.ts` makes four calls, all scoped to the session user, so adjust `createHttpCrm` if your CRM looks different:

| Call         | Request                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------ |
| open tickets | `GET /users/{userId}/tickets?status=open` returns `[{ id, title, summary, status, stepsTried }]` |
| one ticket   | `GET /users/{userId}/tickets/{ticketId}`, 404 when missing                                       |
| add a step   | `POST /users/{userId}/tickets/{ticketId}/steps` with `{ "step": "..." }`                         |
| new ticket   | `POST /users/{userId}/tickets` with `{ "title": "...", "summary": "..." }` returns the ticket    |

## Identify users

Turn on end-user identification for the project in the dashboard and choose how tokens are checked: a server key you share with VoiceThere, your JWKS URL, or a callback URL that VoiceThere calls. In all three modes the client code is the same: your backend issues a signed token for the signed-in person and the browser passes it to `@voicethere/client`.

```typescript
import { startSession, connectBrowserSession } from "@voicethere/client";

const provision = await startSession({
  apiBase: "https://sessions.example/v1",
  projectId,
  headers: { Authorization: `Bearer ${clientKey}` },
  endUserToken, // from your backend
});

const session = await connectBrowserSession({
  mode: "voice",
  credentials: provision.credentials,
  apiBase: "https://sessions.example/v1",
  projectId,
  apiHeaders: { Authorization: `Bearer ${clientKey}` },
});

// The person signs in during the call; the agent's onUserIdentified runs:
await session.identify({ endUserToken: freshToken });

// The person signs out; this closes the session:
await session.logout();
```

A session without a token still works. The agent answers general questions and asks the caller to log in for anything about an account.

## Make it yours

- Edit `prompt.md` for tone and policy.
- Set the provider, model and key as in `llm-agent`: OpenRouter with `anthropic/claude-haiku-5.5` and the secret `AGENT_OPENROUTER_API_KEY`. Thinking models count hidden reasoning against `maxOutputTokens`, so keep replies short in the prompt, not with a small cap.
- Conversation history for users must be enabled for the project; otherwise the agent works from tickets only.
