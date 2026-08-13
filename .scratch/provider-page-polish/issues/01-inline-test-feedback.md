# 01 — Inline test feedback for Upstream Keys

**What to build:** The Upstream Key status badge doubles as the inline
test feedback. While a test is in flight, the badge swaps to a
`Testing…` pill with a spinner. After the test resolves, the badge
reverts to the health badge (which, with the backend fix, now reflects
the verdict), and the upstream's reason rides behind a discoverable
info icon next to the badge that opens a tooltip on hover.

**Blocked by:** —

**Status:** done

- [x] `UpstreamKeyRow` renders a new `TestStatusBadge` in the status cell
      instead of the bare `KeyHealthBadge`.
- [x] While `busy === 'test-${keyId}'`, the badge shows a spinner + the
      word `Testing…` (uses a muted/neutral tone so it doesn't impersonate
      a health verdict).
- [x] When the test resolves, the badge shows the key's `health` as a
      `KeyHealthBadge` (the same one `KeyHealthCard` uses). The badge
      colour now matches the verdict because the backend demotes the
      health on `rejected` and `inconclusive`.
- [x] When `keyView.lastProbe.reason` is non-null, an `Info` icon renders
      next to the badge. The icon is a discoverable affordance (visible
      without hover); hovering or focusing it opens a `Tooltip` with the
      reason text. The icon uses `cursor-help` to signal the affordance.
- [x] The old `TestFeedbackStrip` (the strip below the actions menu) is
      removed; the actions cell goes back to just the action menu.
- [x] A failed `testKey` call (network error, 5xx) does **not** show in
      the badge; the existing `UpstreamKeysCard` destructive Alert at the
      top of the card carries the error. The badge stays on the previous
      health.
- [x] Re-testing a key overwrites the previous `lastProbe` in place; the
      tooltip on the info icon updates to the new reason.
- [x] `testKey` and the verdict-mapping helper are not duplicated; the
      cell reads from the existing `keyView.lastProbe` and the existing
      `busy` label.
- [ ] Browser tests pass. (Defer per `docs/agents/ui-testing.md`; the HTTP
      seam is covered by `test/http/upstream-keys.test.ts`.)

## Implementation notes

- New component `TestStatusBadge` in `provider-detail.tsx`. Renders
  either the `Testing…` pill or `KeyHealthBadge` followed by an `Info`
  icon wrapped in a `Tooltip` when `lastProbe.reason` is non-null.
- The icon is a `button` (`type="button"`, `aria-label`) so it is
  keyboard-focusable and screen readers announce "Last test reason: …".
- Use `Loader2` from `lucide-react` with `animate-spin` for the pending
  glyph; `size-2.5` to match the badge dot.
- The `Testing…` pill is rendered without the info icon; the reason does
  not exist yet while the test is in flight.
