# 30: Edit many rows at once, with mixed values shown

**What to build:** The Owner wants (2026-11-20) what big apps do: select several rows, edit a field once, and it changes on all of them; where the selected rows disagree, the field shows "Mixed" until changed. Research the pattern first (e.g. Linear's multi-select edit, Airtable/Notion bulk edit, Shopify's bulk editor, macOS Finder "Get Info" on several files, Figma's "Mixed" in the properties panel) and write the findings in Comments: how a mixed value looks for a switch, a select, a text field and a multi-select; that untouched fields stay as they are on each row; how saving and Undo work; what to do when a change fails on some rows.

Then build it:

- One reusable bulk-edit piece in `web/src/ui/` (e.g. a "Edit N …" action on the bulk bar opening a panel or sheet with tri-state fields: a Switch / Checkbox with a mixed state, a Select with a "Mixed" placeholder, a text field "Mixed" until typed), used by the tables below. Only fields the Owner changed are sent.
- Decide per table which fields make sense to edit together, and list them in Comments. Likely: Upstream Keys (Enabled, which Endpoints it may use), Models (Hidden from Callers, pinned), Endpoints (Enabled), Gateway Keys (Capture prompts, Enabled), Pool members (weight/enabled if they have them). Names and secrets are never bulk-edited.
- Server: if there is no bulk update for a kind, add one (one call, one Audit Entry per change or one grouped entry with Undo, matching how bulk delete works today), with Go tests, served skill and OpenAPI in step.
- Results follow ticket 04: inline result on the bulk bar, Undo for the whole change, and a partial failure names which rows failed.

**Blocked by:** 25 (select mode changes how rows are selected)

**Status:** open

Owner request, 2026-11-20.

- [ ] Research written in Comments; fields per table listed
- [ ] Reusable bulk-edit piece with mixed states; tests (mixed shown, untouched fields kept, Undo, partial failure; agent test)
- [ ] Bulk update on the server where missing; Go tests; skill and OpenAPI updated
- [ ] Checked in headless Chrome, light, dark and phone width
