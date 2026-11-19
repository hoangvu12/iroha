# Iroha history on other devices (mined 2026-11-19)

Read-only scan of Laptop, Linux SG (sandbox asleep, Docker Sandbox offline). These devices are where iroha was *used*, not built; the one exception is a Laptop session on 2026-11-17 that changed models.dev matching (commit `8ca231f`) and deployed it to ms02.

## Coverage
| Device | Mentions | Substantive sessions | Dates |
|---|---|---|---|
| Laptop | 109/1,572 Claude Code sessions; 3 Pi sessions; 370 Zeron chats | 2: `9bbe5f76` (muse-wonder fix + deploy), `cfedae0b` (council run over iroha models) | 10-25 → 11-18 |
| Linux SG | 8 Claude Code, 214 Pi, 24 `.zeron`, OpenCode DB+log, 83 Zeron chats | ~5; Pi sessions use iroha as their model provider (usage/error data) | OpenCode 08-17; Pi 09-26 → 11-17 |

Useful files on Linux SG: 536-model catalog from 09-22 (`~/.pi/removed-2026-11-17/models.json.bak`); Pi extension `iroha.ts` (same as `~/fleet` copy); Zeron's saved iroha model lists (11-10, 11-17, 11-18); `~/.config/opencode/opencode.json`.

## Timeline
- 08-17 first recorded use (OpenCode): `z-ai/glm-5.1` empty, `dashscope/glm-5.2` 400, `qwen3.7-max` OK.
- 09-22 Pi: static 536-model list, same day switched to live `iroha.ts` extension reading `/v1/models`.
- 09-23 Pi given 10 client-side retries.
- 10-03 → 10-27 Linux SG agent fleets on `dashscope/glm-5.3` (~60k messages); 502 peak 10-17/18.
- 10-26 clients saw "503: Iroha is shutting down" (graceful drain exists).
- 11-07 cobia: "503 Every Upstream Key … unavailable"; user opened extra chats by hand to reach the same model via other routes.
- 11-10 catalog seen by Zeron: 1,980 models (1,801 cobia).
- 11-13 CLIProxyAPI on PC uses iroha as a Claude API key at `/providers/claude`.
- 11-16 `deepai-proxy` (upstream behind iroha's deepai Provider) got a deadlock fix, moved to Easypanel.
- 11-17 catalog down to 256 (cobia, unlockit gone; deepai added); Fleet shares one Pi extension copy; muse-wonder fix deployed; council run hit 401/502/503/402.

## Cases observed
1. OpenAI-compatible `/v1` chat (streaming) + models, Bearer auth.
2. Nested `provider/model` IDs keeping upstream spelling.
3. Models list carries metadata and `chat:"ok"`; clients hide anything not "ok".
4. Image input per model; a vision model for Pi's vision bridge.
5. Plain requests: `max_tokens`, no developer role, no `reasoning_effort`.
6. Stable model IDs (Pi caches the list 24 h).
7. Provider's own context limits beat native ones (DeepAI caps 320k).
8. models.dev fill-in with fixed rules for ambiguous names.
9. A model with no metadata must still work.
10. Model names must match upstream exactly (`gpt-6.astra` typo in deepai Provider still unfixed).
11. Several keys per model; clear retryable 503 when all fail.
12. Drain on shutdown.
13. Pass upstream 400/401/402 through clearly.
14. Survive DashScope internal errors and streams ending without `finish_reason`.
15. Cloudflare 502/520/524 and timeouts on long streams.
16. Same model via several Providers; family namespaces like `gpt/`, `claude/`.
17. Anthropic-shape `/providers/claude` route (used by CLIProxyAPI).
18. Upstreams that are themselves proxies (deepai-proxy, opencode2api, relay-hunt relays).
19. Admin-triggered catalog refresh.
20. `/requests` log page.
21. Docker sandbox allow-list + `IROHA_API_KEY` secret.
22. Possibly tool calls (Kimi via iroha citing nonexistent files — model or iroha unclear).

## Pain points (user quotes)
- "if models.dev cant recognize then its just dont work at all" (11-17, `9bbe5f76`)
- "idk if we can fix this generally or we just have a hardcode list or sth" (11-17, `9bbe5f76`)
- "isnt muse-wonder-1.0 1m context" (11-17, `9bbe5f76`)
- "use dashscope/kimi-k3.1-pro instead, if no work then deepai/…" (11-17, `cfedae0b`) — manual cross-provider fallback.
- "idk if it gonna work along with the sub accounts?" (11-13, `d95911d4`)

Agent friction: ms02 `~/code/iroha` not a git checkout (file-copy deploys, hand-edited deploy marker, sudo password piped in); no admin refresh route used, one-off server script instead; raw errors reach clients (509 bodiless 502s, 113 "terminated" across Linux SG Pi sessions); agents drop the `iroha/` prefix; no reasoning levels on any iroha model; catalog unstable (536 → 1,980 → 256).

## Reversed decisions / open items / clients
- Reversed: static list → live extension; 0 → 10 client retries; per-machine extension → one Fleet copy; an exception added to ADR-0024's "ambiguous stays unset".
- Providers that came and went: bevansatria, nousresearch, mistral, unlockit, cobia; deepai added.
- Open: `gpt-6.astra` typo; muse-wonder missing from the muse relay; models with no metadata breaking.
- Clients: Pi (extension, `/iroha` refresh, vision bridge), Zeron (Pi/OpenCode chats, fleets, councils), OpenCode, CLIProxyAPI, Docker sandboxes. No evidence on these devices of a Discord bot or friends.
