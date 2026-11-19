# 27: Sheets have a backdrop, close on a click outside, and show every record's details

**What to build:** Changes to the record sheet stack (`web/src/sheets/`, tickets 10, 11, 15) asked by the Owner (2026-11-20):

1. **Backdrop.** While any sheet is open, a backdrop dims the page behind the stack (design tokens, light and dark), fading in and out on the sheet tokens with the stack (ticket 15's motion; reduced motion: fade or instant). One backdrop for the whole stack, not one per sheet.
2. **A click outside closes.** A click or tap on the backdrop closes the whole stack. A click on a lower sheet still brings it forward (closes those above it, as today). Escape still closes the top sheet. The chat panel stays above the backdrop and usable while sheets are open (Test in Chat from a sheet keeps the sheet); a click in the chat panel doesn't close sheets. Back still behaves as today. Pages behind can't be clicked while the backdrop is up (the old "page stays usable beside a sheet" behaviour goes; this is the Owner's decision). Check focus: after closing by backdrop, focus returns to what opened the first sheet.
3. **Details in sheets, not dialogs.** Record details still open in dialogs in places, e.g. an Upstream Key's details (`KeyDialog`, `pages/providers/Keys.tsx:927-1213`: state, key reveal/copy/replace, name, Model Gaps, Endpoints, Added/Last used, Delete/Disable/Test in Chat/Test). Show them in the record's sheet (`sheets/records/KeySheet.tsx`, with everything KeyDialog has, then delete KeyDialog) and keep the URL deep link working (old `?key=` links redirect to the sheet). Audit every other Dialog in `web/src` (list in Comments with file:line): a dialog that shows or edits an existing record (Endpoint, Model, Pool member, Failure Rule, Gateway Key, Admin Token…) becomes that record's sheet when a sheet kind exists or fits; create dialogs, confirms, pickers and the snippet dialog stay dialogs. Say for each what you did and why.

**Blocked by:** none

**Status:** open

Owner request, 2026-11-20. Ticket 31 (Failure Rules view) runs at the same time and touches `pages/providers/Rules.tsx`; if Failure Rules get a sheet, keep the change there small and say so.

- [ ] One backdrop under the stack, animated with it, light and dark; tests
- [ ] Backdrop click closes the stack; lower sheet click cuts back; Escape, Back, focus and the chat panel behave; tests incl. agent test
- [ ] Upstream Key details live in KeySheet (KeyDialog gone, old links redirect); every other details dialog audited and moved where it fits
- [ ] Checked in headless Chrome, light, dark and phone width
