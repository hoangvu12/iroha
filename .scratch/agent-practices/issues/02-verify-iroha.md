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
