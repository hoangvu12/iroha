# 24: Gateway Keys page, create dialog and key page

**What to build:** Following `design/v2-clean/` (C02, C12): the Gateway Keys list (name, readable key with copy, scope summary, last used, recent Requests). The create dialog takes a name and Everything or Only some, where Only some is a checklist of Providers (with logos) and Model Pools, each checked Provider showing "All models" that opens the model picker to narrow it. After creation the full key and base URLs are shown with Copy. A key page holds its settings (scope, prompt capture), a Test button that opens the chat as this key, and a danger zone (revoke, delete).

**Blocked by:** 21, 18, 19

**Status:** ready-for-agent

- [ ] Model narrowing handles Providers with thousands of models without lag
- [ ] Capture switch on the key page is reflected on the Requests page
- [ ] Revoke and delete ask for confirmation and are undoable through Audit revert where possible
