# 23: Code blocks are highlighted; Copy fits its label

**What to build:** Three things the Owner noticed (2026-11-20):

1. **Copy button leaves a gap.** `ui/CopyButton.tsx` reserves the width of "Copied" (`data-reserve`), so at rest "Copy" has empty space after it (Gateway Key page, Base URL rows, snippet dialog). At rest the button fits "Copy" exactly. When it changes to "Copied" / "Couldn't copy" it must not jump: animate the width on the motion tokens (measure, or an equivalent technique; see the `animate` skill), or another approach that has no gap at rest and no jarring jump. Reduced motion: instant. Icon-only copy buttons are unchanged.
2. **Syntax highlighting.** No code in the UI is highlighted today. Highlight every `CodeBlock` (`pages/requests/bits.tsx:225`): request and response bodies (JSON) in Attempts, Captured and RouteView, headers, the stream text, and the curl / Python / TypeScript snippets (`pages/chat/SnippetDialog.tsx`), plus Audit Entries' JSON values (`pages/settings/Changes.tsx:161`) if it fits. Colours come from tokens in `styles/index.css`, light and dark, readable on the code-block background. Pick a small highlighter (exact pin; compare bundle cost, e.g. a tiny tokenizer vs Shiki/Prism core with only the needed languages; lazy-load if it's big) and say why in Comments. Bodies can be large (hundreds of KB): don't freeze the page; above a size limit fall back to plain text or highlight off the main path, and test that.
3. **Snippet dialog notes.** Remove the install/run notes under the snippet ("npm install openai, then run as an ES module.", "pip install …", "Needs nothing beyond the standard library…") and the `sn.data.note` line ("Pinning to Upstream Key key-1 is a test-only setting: these snippets are routed like any Caller's Request."). If the server's `note` field then has no reader, drop it from `GET /api/test/snippets` (served skill and OpenAPI in step, Go test updated).

**Blocked by:** none

**Status:** done

Owner request, 2026-11-20.

- [x] Copy has no gap at rest and changes to "Copied" without a jump; tests
- [x] Code blocks and snippets are highlighted in light and dark; large bodies stay fast; tests
- [x] Snippet notes gone (and the unused API field, if unused)
- [x] Checked in headless Chrome, light, dark and phone width

## Comments

**Built (2026-11-20).** Test-first with the `tdd` skill: each behaviour got a failing test (red checked) before the code.

- **Copy fits its label.** `ui/CopyButton.tsx` drops the reserved "Copied" width (`data-reserve`). The label sits in a clipping span whose width is measured before and after the words change and slid with WAAPI on the `indicator` duration and `ease-out` (read through `ui/motion.ts`). An interrupted slide starts from its current width; under reduced motion (or a zeroed token) the width changes at once. Icon copy buttons are unchanged. Chrome: at rest the label is exactly "Copy" (0 px gap to the padding on the Gateway Key page's Key and Base URL), and Copy -> Copied grows 32.7 -> 44.4 px over ~29 frames. The browser check caught a bug the first version had: the built CSS minifies `--duration-indicator` to `.2s`, which `parseFloat` read as 0.2 ms. The test now sets the token the way the build writes it.
- **Highlighting.** `ui/highlight.tsx` is a small tokenizer with no dependency. Every block is JSON, headers, an SSE stream or a snippet Iroha wrote itself, so a few regular expressions cover them all. Cost compared (min + gzip): this tokenizer ~1.5 KB; Prism core + clike/js/ts/json/bash/python ~8.8 KB, plus a global `Prism` and `manual` mode to set up before it is imported; highlight.js core + 4 languages ~33 KB; sugar-high ~5 KB but JS grammars only. Highlighted: request/response bodies in Attempts (`auto`: JSON, a stream event, else plain), RouteView's failure body, Captured raw JSON and the "As streamed" text, Attempt response headers, the curl/Python/TypeScript snippets, and Audit Entries' JSON values. Colours: `--code-*` tokens in `styles/index.css`, light and dark, each at least 4.5:1 on `--bg-subtle` and `--bg-muted` (light 4.5-7.3, dark 4.6-11.9). **Large bodies:** text over 100,000 characters stays plain. A 439 KB Captured body opened in Raw JSON in ~70 ms with no spans. Tested in `highlight.test.tsx` (over the limit: plain and quick; under it: tokenized in <100 ms).
- **Snippet notes gone.** The dialog shows only the code. `note` had no other reader, so `GET /api/test/snippets` drops it (`Snippets.Note` and its OpenAPI doc). The route description, the `upstream_key`/`endpoint` param docs and skill `31_test_chat.md` now say pins are not carried. The Go test now asserts no `note` and no pinned key in the snippets. `MakeSnippets` keeps its signature, so ticket 29's snippet changes merge cleanly.
- **Browser checks** (headless Chrome, light, dark, 390 px phone): Gateway Key page at rest and Copied, Attempts with headers open, Captured raw and stream, Audit Entry JSON, snippet dialog curl and Python, and the 439 KB body. Screenshots and the plan script: `iroha-v2-notes/v2-ui/shots/23/` (`make-plan.mjs` for `ui-screenshots/shot.mjs`). The phone Audit Entries shot did not open an entry (row selector), so the Audit Entry JSON was checked on desktop light and dark only.
- Docs: `architecture.md` has "UI ticket 23" and the ticket 04 Copy line was corrected.