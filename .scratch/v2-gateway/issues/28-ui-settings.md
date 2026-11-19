# 28: Settings: Admin Tokens and Audit Entries

**What to build:** Following `design/v2-clean/` (C28, C29): a plain Settings page, reached from the Owner row (behind the avatar on phones), with two tabs. Admin Tokens lists each token's name, readable secret with copy, created and last used (highlighted when unused for a month), with create and revoke. Audit Entries lists every change with actor, time and what changed; opening a row shows before and after; each row has Revert.

**Blocked by:** 21, 02

**Status:** done

- [x] Revoking a token asks for its name to be typed
- [x] Revert from the UI uses the same API as agents and is itself recorded
- [x] Audit Entries filterable by actor and resource

## Comments

**Built.** `web/src/pages/settings/` (mounted at `/settings/*`, tabs are routes):
- *Admin Tokens* (C28): active tokens with name, token (`iroha_admin_…a91e`, copy on hover and in the ⋯ menu), created, last used (amber when unused for 30 days, counting from creation for never-used tokens). New Admin Token opens a dialog (name, optional note), then shows the whole secret with Copy; the toast offers Undo (reverting the create). Revoke is in the ⋯ menu behind `TypeToConfirmDialog`. Phones get two-line rows.
- *Audit Entries* (C29): grouped by day (Today, Yesterday, then dates), one fact per column: time, actor (Owner or Admin Token), what changed, the record (several children of one Provider show the Provider, other multi-record entries "x and N more"), Revert or "Can't be reverted"/"Reverted". Opening a row shows each changed field's before → after (lists numbered, moved items bold), and a sentence on what Revert would do or why it can't. Revert calls `POST /api/audit-entries/{id}/revert` (the same API agents use; the revert is its own Audit Entry) and toasts with Undo; a conflict names the record that changed since. Search box plus one filter menu (Changed by / Changed what); filters live in the URL and show as chips; "Show older changes" pages with `next_before`.
- *Sign-in* (deferred by ticket 21): Change password (current + new; other browsers are signed out) and the list of signed-in browsers with Sign out per browser (confirm), "Sign out the others", and Sign out for this one, which also gives phones a way to sign out.

**API.** `GET /api/audit-entries/filters`: the actors (Owner first, then Admin Tokens by most recent change, named as in their latest entry and filtered by ID so renames don't matter) and the resources (with labels) that appear in Audit Entries, each with an entry count. Tests: `TestAuditEntryFiltersListTheActorsAndResourcesInUse`, `TestRevertFromTheOwnerSessionIsRecordedAsTheOwner`.

**Checked** in headless Chrome against a seeded in-process server: both tabs light and dark, opened rows, filter menu, no-results chips, create and revoke dialogs, revert with its toast, phone layouts. Tooling for other UI tickets is in `iroha-v2-notes/ui-screenshots/` (outside the repo; referenced from architecture.md).

**Deferred / differences from the mockup.**
- *Expires column* (C28): Admin Tokens have no expiry in the API (ticket 02 did not add one), so the column is left out. Adding it means an `expires_at` field, enforcement in the authenticator and a revert story; worth a ticket if wanted.
- *Footnote*: the mockup says "a token is shown once", but secrets are stored readable (ADR-0006) and the ticket asks for copy, so the line reads "Copy a token whenever a script needs it."
- *Record logos*: targets use the shared `LogoTile` letter fallback or a key/lock icon; Provider and Pool logos appear once ticket 22 gives them an Iroha-served URL (`TargetIcon` in `AuditEntries.tsx` is the one place to add it).
- *Third tab*: the password and sessions live in a "Sign-in" tab rather than as extra sections, to keep the two designed tabs as plain as C28/C29.
