# relay-hunt → iroha: the shared model list

Measured 2026-11-10. Plan: `../relay-hunt/pool/model-plan.json` (and `.md`).
Tool: `scripts/curate-shared-model-lists.ts`. Probe: `../relay-hunt/tools/model_plan.py`.

## The rules this list holds to

- **One model, one id.** `claude-opus-5-5` and `claude-opus-5.5` cannot both exist.
  The canonical id joins the version with a dot: `claude-opus-5.5`.
- **One model, one Provider.** A model belongs to the Provider of the vendor
  that makes it. No model is listed on two Providers.
- **One endpoint, several Providers.** The same relay can be an Upstream Key on
  the `claude` Provider and on the `gemini` Provider — each with the models of
  its own family only, and each with its own spelling for the same model.
- **Only what answers.** A model is listed only if a real completion came back
  from a real endpoint, asked the way the gateway asks (no `max_tokens`).

## What is in production now

| Provider | models | endpoints |
|---|---|---|
| claude | 14 | 15 |
| gpt | 9 | 10 |
| gemini | 7 | 13 |
| muse | 2 | 2 |
| deepseek | 2 | 2 |
| kimi | 2 | 2 |
| grok | 2 | 1 |
| qwen | 2 | 2 |

40 models. Every Provider's catalog is `owner_added` only — no discovered
rows. Every Provider is `modelDiscovery: unsupported`: the list is the
Owner's, not the relay's.

35 of the 40 answered a real completion through iroha's own inference path at
the time of writing. The other five were relays that were down or flapping at
that moment; the set of failures changes between runs. Two of them (`gpt-4o`
on both its endpoints) were genuinely dead — no upstream credentials and a
Cloudflare block respectively.

## Why the Providers were rebuilt rather than patched

The admin API has no route to remove a `discovered` catalog row or to clear a
stored Key Model Availability row. Both are cascaded by a Provider purge, so
`--mode rebuild` archives and purges first and recreates the Provider with the
same handle. The Provider id changes, so a Gateway Key scoped to the old id is
replaced by the script (new secret, printed once).

`--mode in-place` is enough for a delta once the catalogs are clean, but it
cannot add an Upstream Key safely: `POST /providers/:id/keys` runs model
discovery, and six of the relay endpoints answer `GET /v1/models`, which
writes a Key Model Availability row and repopulates the catalog with the
relay's advertised ids. Adding a key through `POST /providers` instead (the
create call takes the keys) does not.

## Re-running it

```bash
cd ../relay-hunt
python tools/model_plan.py --iroha <providers.json> --probe           # ask every endpoint
python tools/model_plan.py --iroha <providers.json> --probe-production --out pool/model-plan.json
cd ../iroha
bun run scripts/curate-shared-model-lists.ts ../relay-hunt/pool/model-plan.json --mode rebuild
bun run scripts/curate-shared-model-lists.ts ../relay-hunt/pool/model-plan.json --mode rebuild --apply --verify
```

`<providers.json>` is the admin `GET /api/v1/admin/providers` answer. The probe
is append-only and resumable: `pool/plan-probe.jsonl` holds the eight-token
sweep, `pool/plan-probe-prod.jsonl` the production-size one.

## Two product issues this work found

**1. Key Model Availability gated a Provider whose model list is managed by
hand.** FIXED AND DEPLOYED — PR #2, `5c7bf3a`, merged as `8859192`.

`ModelCatalogService.discoverMissingKeys` wrote Key Model Availability without
checking the Provider's `modelDiscovery`, unlike `refresh` and
`#probeConnectionKeys`, which both honour `unsupported`. Stored availability
then outranked the allow-list at inference (`provider-registry.ts:1601` returned
`model_unroutable`; `:1609` filtered those keys out), so a Provider whose list
is managed by hand could not route anything. The comparison was also against
the canonical model id while the stored list holds upstream ids, so a rewritten
model could never match.

ADR-0029 records the decision: an explicit per-Key allow-list outranks a
discovered list, and a Key without one keeps exactly the ADR-0023 behaviour.
The stock Providers leave their Keys' lists empty, so their entitlement,
ordering and refusals do not move.

**2. A dead endpoint is not replaced by another endpoint for the same model.**
OPEN. `claude-opus-4.8` was served by five endpoints and failed when the
round-robin landed on one that was down. The retry path visits an alternate
key only after the retry budget is nearly spent, so a fast failure ends the
request. This is why the failing set shifts between verification runs.

## Deployment record

Deployed to `ms02-Ultra` (`100.126.99.55`), the host behind
`iroha.nguyenvu.dev`, on 2026-11-10.

- Pushed `feat/endpoint-model-rewrites`, opened PR #2, merged to `main` as
  `8859192`.
- The deployment tree is a copy of `main`, not a checkout, and several files on
  it differ from the repository only by line endings. Before writing, both
  touched files were confirmed equal to the repository version; the host was
  refused if it had a local change, and the patched file was read back and
  compared with the tested tree.
- Backed up to `/home/ms02/iroha-backups/20261110-081417-availability-fix/`:
  the touched sources and a consistent SQLite copy (`VACUUM INTO`, then
  `PRAGMA quick_check` = ok).
- On-host tests: 45 pass, 0 fail over the four affected suites, run against
  the patched sources on the host itself.
- Restarted `iroha.service`; active, local and public readiness 200.
- Proof in production: adding a Key to a curated Provider no longer writes a
  Key Model Availability row and no longer adds a discovered row to the Model
  Catalog, and the curated model still routes. The scratch Provider used for
  that check was purged.
- Control: the stock Providers' availability rows are unchanged (minimax 87,
  z-ai 59, dashscope 42, mistral 27, sensenova 12, tencent-lkeap 10), and
  dashscope, minimax and z-ai still answer.
- `.iroha-deployed-commit.json` records `8859192`, branch `main`, PR 2.

### PR 4 — chat evidence and failover (2026-11-10)

- Pushed `fix/curated-chat-evidence`, opened PR #4, merged to `main` as
  `ab0a2b7`.
- PR #4 touches no runtime file: only `scripts/curate-shared-model-lists.ts`
  and this document. The running tree was proved to be `main` before anything
  was written — 401 files under `src/`, `migrations/`, `ui/src/` and
  `ui/public/` hashed to `91454f0b2016bedac8255f47cdea61252927b58d89af7cf738a7250b877c9f4a`
  on the host and in the repository, both normalised for line endings. The
  service was therefore **not restarted**: it was already running this code.
- Backed up to `/home/ms02/iroha-backups/20261111-015814-chat-evidence/`:
  the previous handover, the previous deployment record, and a consistent
  SQLite copy (`VACUUM INTO`, then `PRAGMA quick_check` = ok, 71 providers).
- Written and read back: this document, sha256
  `5b3c3de1b1a03aa5a1c5c43b4bd1e23083889174c2bdd27bf7931a3cc3bf85b3`, equal to
  the repository version.
- `.iroha-deployed-commit.json` records `ab0a2b7`, branch `main`, PR 4.
- The data changes went in through the admin API before the deploy: the chat
  overrides, the failover setting on the eight curated Providers, and the
  refreshed plan (six keys dropped, four added, `kimi-k3` in, `gemini-4-argon`
  out).
- Readiness after the deploy: local and public `/health/live` 200,
  `/health/ready` 200 (`sqlite`), `iroha.service` active, no restart.


## Gateway Keys

The five Gateway Keys that were scoped to a rebuilt Provider were replaced.
Their secrets were printed once, at replacement. The six unscoped keys
(`scope: []`) are unaffected — they resolve the Provider at call time. The
superseded revoked keys were deleted afterwards, so 11 keys remain and all of
them are live.

## End to end

Through the public gateway, with a Gateway Key scoped to `claude` and
`gemini`:

```
claude/claude-opus-5.5   -> 200, served claude-opus-5-5
gemini/gemini-3.8-flash  -> 200, served gemini-3.8-flash-high
claude/gpt-6.1-sol       -> 503  (gpt-6.1-sol is not on the claude Provider)
```

The third line is the rule working: one model, one Provider.

## The curated models were invisible to every client that filters on chat support

Found and fixed on 2026-11-10. pi's iroha extension
(`~/.pi/agent/extensions/iroha.ts`) keeps only the models whose directory row
carries chat support:

```ts
if (!m || typeof m.id !== "string" || !m.id || m.chat !== "ok") continue
```

`GET /v1/models` reports `chat` only when the Provider, an unambiguous catalog
entry, or the Owner established it (ADR-0025). The curated rows are
`owner_added` and had been created with a model id alone, so the directory had
no chat evidence for them: 12 of the 14 `claude` models carried no `chat`
field at all, and pi loaded 2 of 14. The same held for every other curated
family — `gpt` 0 of 9 with an override, `gemini` 0 of 7 — and the curated
Provider ids were already in production, so the models were routable the whole
time and only invisible.

The gap was in this import, not in the Gateway. The plan the script consumes
lists only the models that answered a real chat completion, so the Owner
evidence existed and was dropped on the way in. The stock Providers were left
alone on purpose: of the 219 `dashscope` rows, the 101 without chat evidence
are speech, audio, image and `pre-mock_*` upstream fixtures, which are
genuinely not chat models.

**Fix.** `scripts/curate-shared-model-lists.ts` now establishes the chat
capability for every curated model it owns, with
`PATCH /providers/:id/catalog/models/:modelId` and
`{"overrides": {"chat": true}}`. The override is merged into the existing one
instead of replacing it, and it is written in both `--mode in-place` and
`--mode rebuild`, so a rebuild cannot lose it again. ADR-0025 makes the Owner
override authoritative, and per-model overrides are read only by the two
Models surfaces (`global-models.ts`, `inference.ts`), so routing does not
change.

Applied to production on 2026-11-10: 39 models across the eight curated
Providers, no key, Provider or Gateway Key touched. `/v1/models` now reports
`chat: "ok"` for 186 of 294 rows (was 174), all 14 `claude` rows included, and
pi lists all 14 `claude` models against 2 before.

The 12 newly visible `claude` models carry no context length, so pi falls back
to its own 128K/16.4K defaults. Their real limits are unknown to the Gateway:
models.dev has no row for a relay-only model id.

## A dead endpoint ended the request even when a second endpoint served the same model

Found and fixed on 2026-11-10, while checking which curated models answer.
The eight curated Providers carried `retryAmbiguousNetwork: false`; the stock
Providers (`dashscope`, `minimax`) carry `true`. That setting is what lets the
Gateway spend one attempt on another endpoint when a network failure is
ambiguous. With it off, a dead relay returned 502 for a model four other
endpoints were serving — this was open issue 2 in this handover.

`claude/claude-sonnet-5.5` is served by eight endpoints: 502 before the
setting, 200 after. The curated models that answer went from 29 of 39 to
32 of 39.

The curate script now turns the setting on for every Provider it owns, in both
modes. `POST /providers` does not accept it, so a rebuilt Provider starts with
it off and the script sets it immediately after the create.

## The plan was a day old, so the list carried dead models

Refreshed on 2026-11-10 with `tools/model_plan.py --probe-production` against
the live endpoints, 411 production-size asks: 295 answers, 64 connect
failures, 33 refusals of a request without a token budget, 17 rate limits.
Two hosts answered nothing — `52.66.181.17` and the
`sandesh-thapa-omniroute-space.hf.space` Space — and they carried four models.
Applied with the curate script in `--mode in-place`: six keys dropped, four
added, `kimi-k3` arrived, `gemini-4-argon` left because no live endpoint
serves it. 40 curated models now, was 39.

The same evening reported 29 curated models answering, then 34 of 40 ten
minutes later. The six that differ are hosts that blink, not models that are
broken, so the list is left as measured and the failover does the rest. The
plan, the production-size probe rows and the run log are in
`../relay-hunt/pool/` (`model-plan.json`, `refresh-2026-11-11/`).
