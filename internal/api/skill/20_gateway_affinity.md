### Conversation affinity: one conversation, one Upstream Key

Providers cache the start of a prompt per account, so the next turn of a conversation is cheaper and faster when it reaches the key that served the last one. Iroha therefore keeps the turns of one conversation on one Upstream Key (Conversation Affinity), on every Provider unless the Owner turns it off.

**How Iroha knows the conversation.** The first of these that the Request carries:

1. The `Iroha-Session` header: any value up to 256 characters you choose per conversation (a thread or chat ID). Like every `iroha-` header it is never forwarded upstream. Send it when your Caller sends none of the below.
2. Claude Code's session: the `x-claude-code-session-id` header, or the session inside `metadata.user_id` (its JSON form or the older `..._session_<uuid>` form). Subagents share their parent's session, so they share its key.
3. The `session_id` (or `session-id`) and `thread-id` headers, sent by Codex and others (pi). Recorded as source `codex`.
4. The `x-session-id` header, or a `session_id` field in the body.
5. The `x-session-affinity` header, sent by OpenCode and others (pi). Recorded as source `opencode`.
6. The body's `prompt_cache_key`.
7. Otherwise a hash of the prompt's start: the system prompt (or `instructions`, `systemInstruction`), the tool names and the first user message, the first 4 KB of each. Agents append to a conversation, so its start stays the same turn after turn. A prompt with none of these has no conversation and keys go in turn.

A plain `user` field is not a session (it would put one person's parallel conversations on one key). The conversation is combined with your Gateway Key, the Provider and the model, so no Caller can steer another's traffic by sending the same value.

**Which key.** Each usable key of the Provider gets a score from the conversation (rendezvous hashing) and keys are tried highest first, after the usual order: Endpoints of your Shape first, healthy keys before keys back from a cooling, keys known to carry the model first. Over many conversations each key leads about the same share, so load spreads as before. When a conversation's key is cooling, invalid, disabled or removed, that conversation (and only it) moves to its own second key, the same one every turn, and it returns once the first key serves again. A Model Pool keeps its member order; each member ranks its own keys.

**Settings.** `PATCH /api/providers/<handle> {"affinity": "off"}` uses that Provider's keys in turn again (`"on"` is the default). The setting `affinity.experiment` (`PUT /api/settings/affinity.experiment {"value": "half"}`, default `off`) sends about half the conversations round-robin, to measure the difference.

**Seeing it.** Every Request has `affinity`: `source` (`header`, `claude_code`, `codex`, `session_id`, `opencode`, `prompt_cache_key`, `prefix`, `none`), `mode` (`on`; `off`: the Provider's switch; `control`: the experiment's round-robin half; `none`: no conversation) and, with mode `on`, `preferred_served` (whether the conversation's first key answered). `GET /api/requests` and `/api/requests/stats` filter by `affinity=` and `affinity_source=`: compare `affinity=on` with `affinity=control` (tokens, `cache_read`) while the experiment runs. `GET /api/route-preview?model=<provider>/<model>&as=<Gateway Key>&affinity=<session>` shows the key order that key's conversation (as sent in `Iroha-Session`) gets.
