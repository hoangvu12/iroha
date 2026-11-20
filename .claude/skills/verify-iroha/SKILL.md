---
name: verify-iroha
description: Verify an Iroha change by running it: launch a real Iroha with fake upstreams and demo data, drive the admin API, Caller routes and UI pages, and write a PASS, PASS+NOTES or FAIL verdict with evidence into the ticket. Use when asked to verify a ticket or change, or to collect evidence for a verdict.
---

You are the **verifier**: you did not write the change, and your verdict counts only for what you ran. Every claim in the verdict carries the command that showed it and its trimmed output.

Read the ticket first (`.scratch/<feature>/issues/<NN>-*.md`): its "What" and "Done when" are the claims to check. Turn each into a check before launching anything: what to send, what to read back, what counts as the claim holding.

`feature-map.md` (next to this file) says where each UI page and admin resource lives and which `/skill.md` section explains it. `iroha-dev --help` is the launcher's reference.

## Launch

Work from the repo root of the branch under test.

1. **UI.** When the change touches `web/`, or you will open UI pages, build it: `npm --prefix web ci && npm --prefix web run build`. The UI is embedded when the Go binary is built, so build it before step 2.
2. **Build the launcher** to a temp path and run that binary in the background (your tool's run-in-background option, or `&` in a shell that outlives the call), not `go run`: killing `go run` on Windows leaves its child process running. Keep this run's files in one dir, `$TEMP/iroha-verify-run-<id>`.

   ```sh
   R="$TEMP/iroha-verify-run-$$"; mkdir -p "$R"
   go build -o "$R/iroha-dev.exe" ./cmd/iroha-dev
   "$R/iroha-dev.exe" > "$R/iroha-dev.json" 2> "$R/iroha-dev.err"
   ```

   Flags: `--seed demo` (default) or `--seed none` (an empty Iroha: Admin Token and Owner password only), `--port`, `--data-dir` (reuse), `--keep`, `--exit-after` (default 2h, so a forgotten launcher ends itself).
3. **Wait for the JSON**: poll until `$R/iroha-dev.json` holds `stop_url` (seconds; the demo seed sends 32 Requests). If `iroha-dev.err` gains a line starting `iroha-dev:` first, launch failed: go to Doctor.
4. **Read the values**: `. "<env_file>"` (path in the JSON) sets `IROHA_BASE`, `IROHA_ADMIN_TOKEN`, `IROHA_OWNER_PASSWORD`, `IROHA_STOP_URL`, `IROHA_KEY_LAPTOP` (and `_CI`, `_FRIEND`), `FAKE_OPENAI_CHAT_URL`, `FAKE_OPENAI_CHAT_CONTROL` and the same per Shape; source it in each shell call and secrets stay off your command lines. The JSON has the rest: `base_url`, `admin_token`, `owner_password`, `gateway_keys` (`laptop` has every Provider and Pool; `ci` and `friend` are scoped), `fakes` (one per Shape: `url` for an Endpoint, `control` to steer it), `make_fail`, `seeded` (Providers, keys not active, Pools), `data_dir`, `log_file`, `stop_url`, `warnings`. Check `ui` is `true` when you need pages.

Launch is done when `GET <base_url>/readyz` answers 200 and the JSON is in hand.

## Doctor

| Symptom | Cause and fix |
|---|---|
| `port N is taken` | Another process holds it: omit `--port` for a free one. |
| `"ui": false`, pages say the UI was not built | Build the UI (Launch step 1), then rebuild and restart the launcher. |
| `npm ci` or the build fails on syntax or engines | Node is older than 22: `node --version`; use Node 22+. |
| `already holds an Iroha that iroha-dev did not start` | `--data-dir` points at a dir without `iroha-dev.json`: use an empty dir or omit the flag. |
| `seed the demo data: ...` | The change broke an admin route or the Gateway path the seed uses. That is a finding: quote the line, read `log_file`, put it in the verdict. |
| Old launchers still running | `tasklist \| grep iroha-dev`, then `taskkill //F //IM iroha-dev.exe`; delete their temp dirs (`iroha-dev-*` under `$TEMP`). |
| `screenshot.cjs: ... Executable doesn't exist` | No Chromium under `%LOCALAPPDATA%\ms-playwright`: set `IROHA_CHROME` to a Chrome or Edge executable. |

## Drive

`/skill.md` and `/api/openapi.json` of the **running** instance are the API reference: read the sections the ticket touches there (the feature map names them) rather than guessing bodies. Every admin call sends `Authorization: Bearer <admin_token>`; every Caller call sends a Gateway Key the same way.

- **Admin API**: create what the ticket needs (Providers with Endpoints on the fakes' `url`, keys, Pools, settings). Fresh records named for your check keep the demo data out of the way. A check that should change nothing can use `?dry_run=true`.
- **Caller requests**, one per Shape the ticket touches: `POST <base_url>/v1/chat/completions`, `/v1/responses`, `/v1/messages` with model `<provider>/<model>` or a Pool name; Gemini at `/providers/<handle>/v1beta/models/<model>:generateContent`. The answer's `x-request-id` header names the Request.
- **Making fakes fail**: `POST <control>/next?reply=429` queues a reply for that fake's next inference request (`count=N`, `status`, `message`, `code`, `ms`, `retry_after` tune it); `make_fail.replies` lists them (401, 404, 400, 5xx, `slow`, `cut` stream, `hang`, `drop`, `html`). An Upstream Key whose secret holds `fail401` or `fail429` always gets that status. `POST <control>/usage?input=&output=&cache_read=` sets usage; `POST <control>/reset` clears the queue and the record.
- **What reached the fake**: `GET <control>/requests?last=N` gives method, path, headers (lowercase), `body` (parsed JSON, re-encoded) and `raw` (the bytes as sent; use it for byte-for-byte claims). Reset the fake before the request you assert on, so what it lists is yours.
- **Reading back**: `GET /api/requests/<id>` (Attempts, rule, outcome, serving key, usage), `GET /api/requests?...` for the feed, `GET /api/providers/<p>/keys` for Key States, `GET /api/logs?kind=...`, `GET /api/audit-entries?record=...`.
- **UI pages**: install playwright-core once outside the repo, then run the committed script. Pass the page path without a leading slash: Git Bash rewrites `/requests` into a file path.

  ```sh
  npm install --no-save --prefix "$TEMP/iroha-verify-pw" playwright-core@1.62.1
  NODE_PATH="$TEMP/iroha-verify-pw/node_modules" node .claude/skills/verify-iroha/screenshot.cjs "$IROHA_BASE" "$IROHA_OWNER_PASSWORD" providers/openrouter/keys "$R/keys.png" [--full]
  ```

  It signs in as the Owner, opens the page, saves the screenshot and prints JSON with `problems` (console errors, failed requests, 4xx/5xx answers; logos are left out, since iroha-dev fetches none). Look at every screenshot you cite. For clicks and forms, copy the script to `$R` and extend it there.

Behaviour that reads as a bug but is not:

- One fake per Shape serves every demo Provider of that Shape, so a queued reply goes to whichever Provider calls that fake next. Send one request at a time.
- Conversation affinity keeps one conversation on one key: Requests with the same prompt pick the same key. An empty `messages` list has no conversation and goes round-robin.
- A passthrough Request with a conversation gets one free retry without `prompt_cache_key` when the Endpoint answers 400 (prompt caching 04). Queue two 400s to see a 400 reach the Caller.
- Seeded state (`seeded.key_states`): `openrouter/key-3` cooling (30 min), `openrouter/key-5` invalid, `openrouter/key-6` and `groq/key-4` disabled. The demo traffic also cools one `zai` key for `glm-4.6` for a minute (a 429 the next key answers) and fails one `mistral` Request.

Drive is done when every claim from the ticket has a check that ran, with its output kept.

## Evidence

Append the verdict to the `## Comments` of the ticket you verified (add the heading if missing), or where the requester asks:

```markdown
### Verification of <ticket>: PASS | PASS+NOTES | FAIL (<verifier>, <date>)

Ran `<launcher command>` on `<branch>` at `<commit>` (dirty: <git status --short, summarised> when the tree has uncommitted changes); seed <demo|none>, UI <built|not built>.

1. <claim from the ticket>: **PASS**. `<command>` → `<trimmed output that shows it>`
2. <claim>: **FAIL**. `<command>` → `<output>`; expected <...>.

Screenshots: `<path outside the repo>` (<what each shows>).
Notes: <what a reader must know: surprises, flaky steps, claims you could not check and why>.
```

- **PASS**: every claim checked, and each held. **PASS+NOTES**: every claim that was checked held, plus notes the Owner should read (a claim left unchecked, a nearby bug, a doc gap). **FAIL**: a claim did not hold; give the command, the output and what was expected.
- Trim outputs to the lines that prove the point: a status, a header, a field. Name Gateway Keys and Upstream Keys; keep their secrets and the Admin Token out of the verdict.
- Screenshots go under `$R` (outside the repo) unless the ticket asks for them in the repo.
- Write up only what you ran; a claim you could not check goes in Notes as unchecked.

## Cleanup

1. `curl -X POST <stop_url>`: Iroha drains, the fakes stop, and a temp data dir is deleted (`iroha-dev.err` ends with `deleted <dir>`). With `--keep` or `--data-dir`, delete the dir yourself unless asked to keep it.
2. Stop anything else you started and delete your run dir `$TEMP/iroha-verify-run-<id>` (`iroha-dev.json` holds secrets). `$TEMP/iroha-verify-pw` stays: it is the shared playwright-core install.
3. Cleanup is done when `tasklist | grep iroha-dev` lists nothing you started.
