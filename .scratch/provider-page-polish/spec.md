# Provider detail page polish: inline test feedback + code snippet

Two changes to the Owner-facing Provider detail page that close small but
frustrating gaps in the current UX.

## 1. Inline test feedback for Upstream Keys

Today, clicking **Test** in an Upstream Key's action menu runs the test but
gives the Owner no signal that anything is happening, and no clear summary of
the result other than a small status change in the row. The Owner has to
scroll back to the row and compare the badge colour to know whether the test
worked.

We will repurpose the Upstream Key status badge as the inline test feedback:

- while the test is in flight, the badge swaps to a `Testing…` pill with a
  spinner (muted/neutral tone so it does not impersonate a health verdict);
- on completion, the badge reverts to the key's `KeyHealthBadge`. The badge
  colour now matches the verdict because the backend demotes the health on
  `rejected` (→ `invalid_authentication`) and `inconclusive`
  (→ `cooling_down`);
- when the upstream returned a reason, an `Info` icon renders next to the
  badge. The icon is a discoverable affordance (visible without hover);
  hovering or focusing it opens a `Tooltip` with the reason text. The icon
  uses `cursor-help` to signal the affordance;
- a failed `testKey` call (network failure, 5xx) collapses into the existing
  destructive Alert above the keys table. The badge stays on the previous
  health.

The badge is the single source of truth for both the durable health and the
most recent test; no separate strip or row appendage. The info icon is the
single source of truth for the reason — no paragraph of text below the badge
duplicating what the tooltip says.

## 1a. Backend: test verdict is the source of truth for post-test health

To make the badge honest, the backend's `testKey` (and the background trial
loop that shares the same patch) now sets the key's `health` from the
verdict, with one exception:

- `usable` on a non-disabled key → `active` (existing).
- `rejected` on a non-disabled key → `invalid_authentication` (new).
- `inconclusive` on a non-disabled key → `cooling_down` with a 30-second
  `retryAfterAt` (new).
- any verdict on a `disabled` key → no health change (existing, preserved).

The audit event records `previousHealth` and `newHealth` so the history of
why a key entered its current state is recoverable. See
`docs/adr/0007-test-verdict-demotes-upstream-key.md`.

## 2. Code snippet section

A new full-width card placed immediately after the Upstream Keys card. It
gives the Owner a copy-paste-ready request to the Gateway that uses the
Provider's ID, the Provider's known models, and a `<gateway-key>` placeholder
they fill in with one of their active Gateway Keys.

The card contains:

- a model picker sourced from the Provider's catalog (default: the first
  non-excluded known model);
- a three-tab language switcher: **cURL · OpenAI JS SDK · OpenAI Python SDK**;
  both SDK variants use the OpenAI SDK so the snippet is a one-line
  `baseURL` swap, not a new client to learn;
- a copy-to-clipboard button that copies the currently visible snippet;
- nothing else — no prose, no link to the Gateway Keys area.

The Gateway URL is the Owner-facing origin of the admin UI plus
`/providers/{providerId}/v1/chat/completions`, which is the same shape
documented in `docs/adr/0001-provider-scoped-openai-routes.md`.

## Glossary

- **Test verdict** — the last `KeyView.lastProbe.verdict` for an Upstream
  Key: `usable`, `rejected`, or `inconclusive`. New term, added to
  `CONTEXT.md`.

## What this spec is not

- No new HTTP route or backend change. The existing
  `POST /providers/:id/keys/:keyId/test` and
  `GET /providers/:id/catalog` endpoints carry the data we need.
- No browser/JS-DOM tests. Per `docs/agents/ui-testing.md`, the HTTP seam
  is already covered by `test/http/upstream-keys.test.ts` and
  `test/http/model-catalog.test.ts`.
- No toast/sonner. The user asked explicitly for inline feedback, not
  toast.

## Tickets

- `01-inline-test-feedback.md` — the per-row test strip.
- `02-code-snippet-section.md` — the new code snippet card.
