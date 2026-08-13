# 02 — Code snippet section on the Provider detail page

**What to build:** A new full-width card placed immediately after the
Upstream Keys card on the Provider detail page. It gives the Owner a
copy-paste-ready request to the Gateway that uses the Provider's ID, the
Provider's known models, and a `<gateway-key>` placeholder.

**Blocked by:** —

**Status:** done

- [x] A new full-width card titled **Code snippet** renders directly below
      `<UpstreamKeysCard />` in `ProviderDetail`.
- [x] The card loads the Provider's catalog via `fetchCatalog(providerId)`
      and lists every non-excluded model in a model picker. The default
      selection is the first non-excluded model; the picker is disabled
      while the catalog is loading and shows "Loading models…" / "No models
      yet" placeholder states.
- [x] Changing the model re-renders the snippet body without losing the
      current language tab.
- [x] A three-tab language switcher is rendered: **cURL · OpenAI JS SDK ·
      OpenAI Python SDK**. Both SDK variants use the `openai` client with a
      `baseURL` pointing at the Gateway; only the language differs.
- [x] Each tab's body is a copy-paste-ready code block (`<pre>` with
      monospace text). The Gateway URL is built from
      `window.location.origin` + `/providers/${provider.id}/v1/chat/completions`
      for cURL and `window.location.origin` + `/providers/${provider.id}`
      for the SDKs.
- [x] The placeholder for the credential is the literal string
      `<gateway-key>` so a copy/paste never silently includes a real secret
      the Owner might leak into a chat.
- [x] A copy-to-clipboard button per code block. Clicking it copies the
      visible snippet and the button briefly shows a "Copied" label so the
      Owner knows the action worked. No toast.
- [x] Catalog fetch failures render the card empty (the picker shows "No
      models yet"); the section does not crash the page.
- [x] Card has no prose, no link to the Gateway Keys area, no help blurb —
      switcher, model picker, copy button, and the snippet only.
- [ ] Browser tests pass. (Defer per `docs/agents/ui-testing.md`; the HTTP
      seam is covered by `test/http/model-catalog.test.ts` and
      `test/http/inference-chat-completions.test.ts`.)

## Implementation notes

- New file `ui/src/components/code-snippet-card.tsx`. Co-locate because the
  component is small and only used by `ProviderDetail`.
- Reuse the existing `Button` (size `xs`, variant `outline` for the
  language tabs; variant `ghost` size `icon-xs` for the copy button) and
  `Select` (for the model picker).
- For the language switcher, use a button group: three `<Button>`s with
  `variant={isActive ? 'secondary' : 'ghost'}` and `aria-pressed`.
- The copy action: `navigator.clipboard.writeText(snippet)`. Guard with a
  `try` so a permissions failure falls back to a "Copy" label without
  throwing.
- The card is always rendered (even with no models); the picker shows
  "No models yet" and the snippet is the cURL with `model: ''` so the
  Owner can still see the URL shape.
- The card is **not** gated on `provider.archived`; an archived Provider
  is still useful to copy a snippet from.
