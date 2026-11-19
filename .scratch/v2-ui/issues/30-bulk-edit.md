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

## Comments

### Research (before building)

References looked at (Mobbin screens via `poppin`, saved in `iroha-v2-notes/v2-ui/shots/30/refs/`; the rest from the products' own behaviour and platform guidance):

- **Twenty CRM, "Update records · 3 selected"**: select rows, a panel opens beside the table with every editable field. Fields start empty and only the ones filled in are applied; footer Cancel / Apply. Closest to what Iroha needs.
- **Airtable, bulk "Field permissions"**: a small modal names what it changes ("Limit who can edit values in Project Name and Project Description"), one select, Confirm disabled until something changes.
- **Notion**: selecting rows turns the toolbar into "2 selected" with one button per property; picking a value applies it to every selected row. Same as Iroha's bulk bar today.
- **Shopify bulk editor, Square "Bulk edit items"**: a full spreadsheet page, one row per record, "Update 2 variations". For many fields per record; too heavy for Iroha's few switches.
- **Linear**: with several issues selected, the Labels menu shows a tick for labels every issue has and a dash for labels only some have; a status menu ticks nothing when they differ.
- **Figma properties panel**: a value the selection doesn't share shows "Mixed" in the field; typing a value sets it on all; leaving it alone keeps each layer's own.
- **macOS Finder "Get Info" on several files**: a checkbox the files disagree on ("Locked") shows a dash (mixed); a text field shows nothing. Apple HIG: a mixed-state checkbox means "on for some items, off for others"; pressing it sets one value for all. **Gmail labels** on several mails: the same dash; pressing cycles the label to "on for all", then "off for all", and an Apply appears once anything changed.

How a mixed value looks, for each kind of control (what was built):

- **Switch / yes-no**: UI SDK's Switch has no mixed state and a half-way thumb reads as broken, so a yes-no field is a **checkbox with a dash** (Finder, Gmail), with "Mixed: on for 2 of 5 keys" beside it. A press sets "on for all", the next "off for all" (UI SDK's checkbox order); "Keep as is" brings the dash back.
- **Select**: no option shown, the placeholder **"Mixed"** in the muted placeholder colour (Figma). Picking one sets it for all.
- **Text field**: empty with the placeholder **"Mixed"** (Figma); a shared value is shown as the value. What's typed is set on all; emptying a field that was mixed means "leave it".
- **Multi-select (a set, e.g. a key's Endpoints)**: one checkbox per option, ticked when every selected row has it, empty when none has it, a **dash with "2 of 5"** when some have it (Linear labels). Each option's change is a delta: ticking adds that option to every row, unticking removes it, options left alone stay as each row has them.

Rules taken from all of them:

- **Untouched fields stay as they are on each row.** Only fields the Owner changed are sent; a row's other values are never rewritten with a shared guess. A field that was changed shows "Changed" and a "Keep as is" button that puts it back untouched; setting a field back to its shared value counts as untouched.
- **Saving**: one Apply button ("Apply to 5 keys"), disabled until something changed. One API call, one Audit Entry (Twenty, Airtable). If the call itself fails, the dialog stays open with the error and the draft.
- **Undo**: the result shows in the bulk bar (where Edit was pressed; ticket 04), with Undo reverting the one Audit Entry for every row at once.
- **Partial failure**: the rows that worked stay changed (Undo reverts them); the result line turns red and names the rows that failed and why ("3 keys changed; team-4 wasn't: …"). Nothing is retried silently.

Where it lives: a dialog, not a sheet. Sheets are for linked records in the URL (ticket 10, 27 moves *details* dialogs into sheets, but keeps create dialogs, confirms and pickers as dialogs); a bulk edit is a short form about the selection, gone once applied, like Add keys.
