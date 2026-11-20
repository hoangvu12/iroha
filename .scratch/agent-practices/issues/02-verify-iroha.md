# 02: verify-iroha, a launcher and a verification skill

Status: open
Blocked by: none

## Why

Today a change is checked by its author (tests) and by the orchestrator reading the diff. Nobody runs the built Iroha the way an Owner or Caller would before merge. pstack's rule: only a verdict from an agent that did not write the code counts, and it comes from running the change (`docs/research/pstack-agent-practices.md`, items 4 and 5). The README work showed what that takes: building the UI and binary, a temp data dir, the bootstrap token, an Owner password, fake upstreams, seed data, then curl and Playwright. Each agent had to invent it; the scripts were thrown away.

## What

1. **A launcher** that starts a real Iroha (the same `server` code the binary runs, with the embedded UI when built) on a free localhost port with a fresh temp data dir, plus fake upstreams for every Shape on localhost, and seeds demo data through the admin API. One command, e.g. `go run ./cmd/iroha-dev` (name it as fits). It prints one JSON object: base URL, Admin Token, Owner password, Gateway Keys, the fake upstreams' URLs and how to make them fail (429, 401, 404, 5xx, slow, stream cut), and the data dir. Flags at least: `--port`, `--data-dir` (reuse), `--seed demo|none`, `--keep` (keep the data dir on exit). Clean shutdown on Ctrl-C. Never reaches a real Provider or models.dev.
   - The fakes in `internal/testkit` take `testing.TB`. Choose the cleanest way to reuse their behaviour outside tests (e.g. move the fake server core into a package that doesn't need `testing`, with testkit wrapping it), keeping every existing test passing. Don't duplicate the fakes.
   - The seed resembles the README demo (`docs/screenshots/`): several Providers with Endpoints on the fakes, keys in every Key State, a Model Pool, Gateway Keys `laptop`, `ci`, `friend`, and a burst of Requests incl. cache reads and a failure. `--seed none` gives an empty Iroha with only the token and password.
   - Short `--help`, JSON output, errors that say what to do.
2. **The skill** `.claude/skills/verify-iroha/SKILL.md` in the repo (project skill; also readable by any agent), written for agents (see `C:\Users\ADMIN\.claude\skills\writing-for-agents\SKILL.md` and follow it), with sections:
   - **Launch**: build the UI when the change touches `web/` (or the embedded UI is missing), start the launcher, read its JSON.
   - **Doctor**: what to check when launch fails (port, missing `dist/`, Node version) and the fix.
   - **Drive**: admin API with the Admin Token (point to `/skill.md` and `/api/openapi.json` of the running instance instead of copying them), Caller requests in each Shape with a Gateway Key, making fakes fail, reading Requests and Attempts back, UI pages with Playwright (Chromium is installed under `%LOCALAPPDATA%\ms-playwright`; include a small committed script that logs in and screenshots a given path).
   - **Evidence**: what a verdict contains: commands run with trimmed output, screenshots for UI changes (saved outside the repo unless asked), and the verdict `PASS`, `PASS+NOTES` or `FAIL` with what failed. Leave out anything not run.
   - **Cleanup**: stop everything, delete temp dirs.
   - A **feature map** (separate file next to the skill): each UI page and admin resource, what it does, how to reach it, which `/skill.md` section covers it. Point, don't copy.
3. **Prove it** by verifying a change that already landed, as a verifier would: prompt caching 04 (`.scratch/prompt-caching/issues/04-conversation-ids-on-every-attempt.md`): a Chat Caller request through passthrough reaches the fake with `prompt_cache_key` and the session headers and without `Iroha-Session`; with the Endpoint's `send_prompt_cache_key: off` neither arrives; a fake answering 400 to the first try gets a plain retry that succeeds. Write that verdict, in the Evidence format, into the ticket's `## Comments` here.

## Done when

`go vet ./...`, `go test ./...` pass; the launcher works from a clean checkout (`npm --prefix web ci` + build first if needed) and from `--help`; the skill and feature map exist; the proof verdict is in Comments with the decisions you made. Commit on your branch; don't merge, push or deploy.

## Comments

### Verification of prompt caching 04: PASS+NOTES (Claude Opus 5.5, independent verifier, 2026-11-21)

Ran `go build -o "$TEMP/iroha-dev.exe" ./cmd/iroha-dev && "$TEMP/iroha-dev.exe" --exit-after 1h` on `agent-practices-02` at `ed4c49c` (contains the merge of prompt caching 04, `109fa54`), with uncommitted launcher files in the worktree; seed demo, UI built (`"ui": true`, not used). `GET /readyz` → 200. Set-up: a fresh Provider `pc04` with one Endpoint `chat` (`openai-chat`, on the `openai-chat` fake's `url`) and one Upstream Key `key-1`, called with Gateway Key `laptop` (`scope {"all": true}`) on `POST /v1/chat/completions`, model `pc04/gpt-verify`, body `{"messages":[{"role":"user","content":"hello pc04"}]}`, header `Iroha-Session: verify-pc04-conv-1`. Before each call: `POST <openai-chat control>/reset`; after it: `GET <control>/requests?last=N`.

1. A passthrough Chat request reaches the fake with `prompt_cache_key` and the session headers, and without `Iroha-Session`: **PASS**. Request `req_qnwlblith2dm2q62` → HTTP 200, `affinity {source: header, mode: on}`. The fake got `path /v1/chat/completions`, `x-session-affinity = x-session-id = session_id = 4b0ce813-eeb4-5903-ac2e-2f8122fbe216`, no `iroha-session` (headers: `accept, accept-encoding, authorization, content-length, content-type, idempotency-key, session_id, user-agent, x-session-affinity, x-session-id`), and body `{"model":"gpt-verify","messages":[...],"prompt_cache_key":"4b0ce813-eeb4-5903-ac2e-2f8122fbe216"}`.
2. With `send_prompt_cache_key: off`, neither the body field nor the session headers arrive: **PASS**. `PATCH /api/providers/pc04/endpoints/chat {"send_prompt_cache_key":"off"}` → `send_prompt_cache_key: off`, `caching.prompt_cache_key: false`. The same request (`req_gb5x6ic4mdqjx6wd`) → HTTP 200. The fake got headers `accept, accept-encoding, authorization, content-length, content-type, idempotency-key, user-agent` (no session headers, no `iroha-session`) and body `{"model":"gpt-verify","messages":[{"role":"user","content":"hello pc04"}]}`.
3. A 400 to the first try gets a plain retry that succeeds: **PASS**. The setting went back to `""`, then `POST <control>/next?reply=400` → `{"queued":1}` and the same request (`req_wc7luurypi5ardv7`) → HTTP 200. The fake got two requests: the first with `prompt_cache_key` in the body, the second without it (`session_id` was on both, as the ticket intends). `GET /api/requests/req_wc7luurypi5ardv7` → `status 200`, `summary "#1 key-1: the Endpoint refused the request with prompt_cache_key added by Iroha ..., the only change to the Caller's request -> no rule, retry_elsewhere; #2 key-1: 200"`. Attempt 1: `key-1`, `status 400`, `outcome retry_elsewhere`. Attempt 2: `key-1`, `status 200`. Afterwards `key-1` is still `active` ("no Attempt has failed since").

Screenshots: none (no UI claims).
Notes:
- The fake's `/requests` gives `body` as parsed JSON, not as raw bytes, so this run cannot show the ticket's "byte-preserving, only the appended field" property. Only the Go test `TestPassthroughAddsTheConversationIDAndNothingElse` covers it.
- With `off`, the Endpoint's `caching.summary` reads "...; no prompt_cache_key is added." It does not say that the session headers stop too, but they do (claim 2). This is a small doc gap in `caching.Describe`.
- The Attempt budget (`max_attempts: 1`), the "plain retry also 400" case and the "key-problem 400 not retried" case were not checked; they were not among the claims.

### Implementation notes and decisions (implementer, 2026-11-21)

What landed: `cmd/iroha-dev` (the launcher), `internal/fakeupstream` (the fakes, moved out of `testkit`), `.claude/skills/verify-iroha/` (`SKILL.md`, `feature-map.md`, `screenshot.cjs`), package map rows in `docs/agents/architecture.md`, one line in `README.md`.

Decisions:
- **Reusing the fakes**: `testkit/upstream.go` and `shapes.go` moved (git mv) to `internal/fakeupstream`, which has no `testing` import and takes a `clock.Clock` for `Received.At` and reply delays (ticket 01's time rule). `testkit.Upstream` embeds `*fakeupstream.Upstream` and overrides only `Last`, `Await` and `Client` (fail the test, register cleanup); `Reply`, `Responder`, `Received`, `Usage`, `Chunk` are type aliases and `JSON`/`Raw`/`SSE`/`Hang`/`Drop` thin wrappers, so no existing test changed. New in the fake: `Usage.CacheRead` (cache fields per Shape, only when set), `SetUsageWith`, `Reset`, `Queued`, `ThenCut(n)`, and the opt-in HTTP control `EnableControl` (`/_fake/next|default|requests|usage|reset`) plus `fail<status>` secret markers, so an agent with curl can steer fakes running in another process.
- **One fake per Shape**, shared by the demo Providers, rather than one per Provider: four URLs to explain instead of nine. The skill says to send one request at a time because of it.
- **Key States in the seed** come from key tests against the fakes (secrets `...-fail429`, `...-fail401`; a 429 cools per model, so the cooling key is tested on each of its models until it escalates to the whole key) and the Owner's disable, so they are real states, not rows written behind the API. Demo Providers have `discovery: none` and added models, so the daily refresh never rewrites the lists from the shared fakes.
- **Stopping**: besides Ctrl-C, a `stop_url` on its own localhost port (agents' background tools cannot send Ctrl-C, and killing `go run` on Windows orphans the child) and `--exit-after` (default 2h) so a forgotten launcher ends itself. The skill builds the binary rather than using `go run`.
- **Safety**: Iroha gets an HTTP client that dials loopback only, and `config.Config` leaves models.dev and the logo templates empty, so nothing leaves localhost.
- **Reuse**: `--data-dir` stores the secrets in `<dir>/iroha-dev.json` (the bootstrap token is shown once) and moves Endpoints on the previous run's fake origins to the new ones; such a dir is never deleted. Every run also writes `<data_dir>/iroha-dev.env` (sh variables) so a verifier sources it instead of parsing JSON.
- **Screenshots**: no Playwright dependency in `web/`; the skill installs `playwright-core@1.62.1` once under `$TEMP/iroha-verify-pw`, and `screenshot.cjs` uses the newest Chromium under `%LOCALAPPDATA%\ms-playwright` (the installed `chromium-1248` didn't match playwright-core 1.62.1's expected headless shell). It signs in through `POST /api/session` and reports console errors and 4xx/5xx answers (logo 404s left out).
- **The proof** was run by a separate agent that had not seen the launcher's code, following only the skill (verdict above). Its eight skill problems were fixed before commit: the fake's `/requests` now also gives `raw` (bytes as sent), the env file, background-run wording, `--help` usage line, seeded-state wording, the verdict title names the verified ticket and records a dirty tree, and a per-run `$TEMP/iroha-verify-run-<id>` dir that cleanup deletes while the shared Playwright install stays. Its note on `caching.summary` not mentioning the session headers under `off` is left for a prompt-caching follow-up.

Tests: `cmd/iroha-dev/main_test.go` (demo seed in every Key State with cache reads and a failure, fake control, loopback-only client, temp dir deleted; reused dir keeps secrets and moves Endpoints; flag errors; taken port), `internal/fakeupstream/control_test.go`.
