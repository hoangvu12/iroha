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

**1. Key Model Availability gates a Provider whose discovery is off.**
`ModelCatalogService.discoverMissingKeys` writes Key Model Availability without
checking the Provider's `modelDiscovery`, unlike `refresh` and
`#probeConnectionKeys`, which both honour `unsupported`. Stored availability
then outranks the allow-list at inference (`provider-registry.ts:1601` returns
`model_unroutable`; `:1609` filters those keys out), so a Provider whose list
is managed by hand cannot route anything. Worse, the comparison is against the
canonical model id while the stored list holds upstream ids, so a rewritten
model can never match. Either skip the availability write when discovery is
`unsupported`, or compare the rewritten id.

**2. A dead endpoint is not replaced by another endpoint for the same model.**
`claude-opus-4.8` was served by five endpoints and failed when the round-robin
landed on one that was down. The retry path visits an alternate key only after
the retry budget is nearly spent, so a fast failure ends the request.

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
