# 23: Code blocks are highlighted; Copy fits its label

**What to build:** Three things the Owner noticed (2026-11-20):

1. **Copy button leaves a gap.** `ui/CopyButton.tsx` reserves the width of "Copied" (`data-reserve`), so at rest "Copy" has empty space after it (Gateway Key page, Base URL rows, snippet dialog). At rest the button fits "Copy" exactly. When it changes to "Copied" / "Couldn't copy" it must not jump: animate the width on the motion tokens (measure, or an equivalent technique; see the `animate` skill), or another approach that has no gap at rest and no jarring jump. Reduced motion: instant. Icon-only copy buttons are unchanged.
2. **Syntax highlighting.** No code in the UI is highlighted today. Highlight every `CodeBlock` (`pages/requests/bits.tsx:225`): request and response bodies (JSON) in Attempts, Captured and RouteView, headers, the stream text, and the curl / Python / TypeScript snippets (`pages/chat/SnippetDialog.tsx`), plus Audit Entries' JSON values (`pages/settings/Changes.tsx:161`) if it fits. Colours come from tokens in `styles/index.css`, light and dark, readable on the code-block background. Pick a small highlighter (exact pin; compare bundle cost, e.g. a tiny tokenizer vs Shiki/Prism core with only the needed languages; lazy-load if it's big) and say why in Comments. Bodies can be large (hundreds of KB): don't freeze the page; above a size limit fall back to plain text or highlight off the main path, and test that.
3. **Snippet dialog notes.** Remove the install/run notes under the snippet ("npm install openai, then run as an ES module.", "pip install …", "Needs nothing beyond the standard library…") and the `sn.data.note` line ("Pinning to Upstream Key key-1 is a test-only setting: these snippets are routed like any Caller's Request."). If the server's `note` field then has no reader, drop it from `GET /api/test/snippets` (served skill and OpenAPI in step, Go test updated).

**Blocked by:** none

**Status:** open

Owner request, 2026-11-20.

- [ ] Copy has no gap at rest and changes to "Copied" without a jump; tests
- [ ] Code blocks and snippets are highlighted in light and dark; large bodies stay fast; tests
- [ ] Snippet notes gone (and the unused API field, if unused)
- [ ] Checked in headless Chrome, light, dark and phone width
