# DeepAI Theos entitlement

Iroha can read the DeepAI Code allowance of an Upstream Key and retire a key whose
daily Theos ran out, so a Provider holding several DeepAI accounts rotates between
them instead of refusing Requests once one account is empty.

## Why this is worth reading authoritatively

DeepAI Code meters its frontier models in Theos. The allowance is per **account**,
not per machine and not per network, and it is assigned by the server when the
account first claims it. Measured on three accounts of one person, created from
the same home network on the same day, two of them the same way:

| Account | Granted | Balance at the time of reading |
|---|---|---|
| desktop-app account | 50.00000 | 30.45602 |
| website account | 51.00000 | 50.95047 |
| website account, later | 71.00000 | 71.00000 (untouched) |

The number did not move across a refresh boundary, so it reads as fixed at the
first grant. Independent measurements elsewhere saw 45, 65, 85, 200 and 0 for other
accounts, with no published rule for the difference — so the reading is
authoritative about *what is left*, and never about *why*.

## The entitlement surface

A `deepai-proxy` gateway answers `GET /theos` for the credential the caller
presents: the capability token and the gateway's configured key report the
gateway's own account, and with `--client-keys` a presented DeepAI key reports
its own account. So the Provider's Upstream Key is the unit the reading is about,
which is exactly the Capacity Scope "key" that routing eligibility needs.

A presented key that holds no grant is claimed before it is reported, so the
reading answers "what can this key spend through this gateway" rather than "what
did the upstream happen to have credited".

## Changes

- `src/usage/deepai-usage-adapter.ts` — a typed Usage Adapter that reads the
  entitlement surface and normalizes it into the shared reading: `balance` is
  what is left of the day's grant, `limit` is the grant itself, `resetAt` is
  when the grant comes back. It is authoritative: a confirmed zero is proof of
  absence and retires the key, while an unreadable body is a parse failure and
  never a silent zero.
- `src/providers/packs/deepai.ts` — the DeepAI Code Provider Pack. The Inference
  Adapter is the generic one, because the gateway speaks the OpenAI wire shape;
  the Pack's Template seeds the brand URL, so the Owner points the base URL at
  their own gateway.
- `ui/src/components/provider-detail.tsx` — Theos reads as an absolute balance
  ("30.45602 Theos", "Exhausted") rather than a window percentage.
- `test/usage/deepai-usage-adapter.test.ts` — eleven tests: the read and its
  URL, exhausted and available evidence, reconciliation keeping a spent key
  parked, a zero grant reading as exhausted with its reset, a body without the
  amounts failing to parse rather than reading as zero, and the refusal,
  unreachable, unparseable and cancelled paths.

## What it does not claim

The reading says how much Theos a key has left. It does not say how much a
Request will cost: DeepAI's per-model prices are estimates that scale with
token usage, and a cached prompt is billed at the same rate as an uncached one.
