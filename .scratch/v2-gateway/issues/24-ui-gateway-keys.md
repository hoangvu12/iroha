# 24: Gateway Keys page, create dialog and key page

**What to build:** Following `design/v2-clean/` (C02, C12): the Gateway Keys list (name, readable key with copy, scope summary, last used, recent Requests). The create dialog takes a name and Everything or Only some, where Only some is a checklist of Providers (with logos) and Model Pools, each checked Provider showing "All models" that opens the model picker to narrow it. After creation the full key and base URLs are shown with Copy. A key page holds its settings (scope, prompt capture), a Test button that opens the chat as this key, and a danger zone (revoke, delete).

**Blocked by:** 21, 18, 19

**Status:** done

- [x] Model narrowing handles Providers with thousands of models without lag
- [x] Capture switch on the key page is reflected on the Requests page
- [x] Revoke and delete ask for confirmation and are undoable through Audit revert where possible

## Comments

- Built `web/src/pages/gateway-keys/`: list (name, readable key with copy, access summary, last used, Requests of the last 24 h linking to the filtered Requests feed; revoked keys folded below; two-line rows on phones), the create dialog (C02/C24: name, Everything or Only some, Providers with logo tiles and Pools, "All models" opening the model picker) and the created dialog (C12: key and base URLs with Copy), and the key page at `/gateway-keys/<ID>` (rename, key, base URL, access with Edit access, prompt capture switch, activity, danger zone with Revoke and Delete, Test opening the chat as the key).
- Model narrowing: server-side search and pages of 200 from `GET /api/providers/{p}/models`, only rows in view are drawn (checked with 3,003 models in a headless browser); a typed ID the list lacks can be allowed.
- API: `recent_requests` on Gateway Keys and `DELETE /api/gateway-keys/{key}` (revertible), HTTP tests in `internal/gatewaykeys/activity_test.go`; skill note `24_gateway_keys.md`. The capture switch is the existing `PATCH capture`; Requests show `captured` from then on (`internal/requests` tests already cover it).
- Revoke asks for the name typed and cannot be undone (the API makes it irreversible); delete asks for confirmation and its toast offers Undo through the Audit revert.
- Logos are letter tiles until ticket 22 serves them: change `providerLogo` / `poolLogo` in `logos.tsx`. Test passes `{ kind: "gateway_key", gatewayKey: <name> }` to `useChatPanel().open`; ticket 23 renders it.
