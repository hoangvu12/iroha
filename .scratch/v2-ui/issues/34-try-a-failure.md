# 34: Try a failure against the Failure Rules

**What to build:** The Owner said yes (2026-11-20) to ticket 31's proposal: on a Provider's Rules tab, the Owner types a failure and sees which rule catches it and what happens.

1. **API.** `POST /api/providers/{provider}/rules/classify` (or `POST /api/rules/classify` with `provider`; follow the route conventions in architecture.md) taking `{status, body, headers?, model?, endpoint?}` and answering what the live engine decides for that Provider's compiled rules: the rule that matched (or none), the outcome for the Upstream Key (cool for how long, invalid, Model Gap, nothing) and for the Request (retry elsewhere, return the error), and the reason text the Requests page would show. It must call the same code the gateway uses (`Set.Classify` and how the gateway reads a failure: errors inside a 2xx, codes from the JSON error fields, SSE bodies, host scopes), not a copy. Read-only: no Audit Entry, nothing stored. Go tests with testkit for a built-in match, an Owner rule winning over a built-in, a switched-off rule skipped, no match (the engine's fallback), an error inside a 200, an SSE body. Served skill and OpenAPI in step.
2. **UI.** In the Flow view (`pages/providers/RulesFlow.tsx`, ticket 31), a "Try a failure" panel: status (number), body (a code field, ticket 23's highlighting if it fits), optional headers; a few example failures to fill it in one click (e.g. 429 rate limit, 401 invalid key, 404 model not found, 200 with an error body). On Try, the path lights up down to the rule that matched and its branch (key effect, Request effect), steps it passed are marked as "didn't match", and the result is said in words above the flow ("Rule model-not-found matches: the key gets a Model Gap for this model; the Request tries the next key"). No match lights the End card. Editing the inputs clears the highlight. Phone width: same, stacked. Reduced motion respected for any highlight motion.

**Blocked by:** none

**Status:** open

Owner request, 2026-11-20 (proposed in ticket 31's Comments). Ticket 33 runs at the same time and changes how a Flow step opens (a `rule` sheet instead of the dialog): keep your RulesFlow edits additive (the panel and highlight state), don't touch step click handling.

- [ ] Classify route answers what the engine decides; Go tests for the cases above; skill and OpenAPI updated
- [ ] Try-a-failure panel with examples; path and result highlighted; tests incl. agent test
- [ ] Checked in headless Chrome, light, dark and phone width
