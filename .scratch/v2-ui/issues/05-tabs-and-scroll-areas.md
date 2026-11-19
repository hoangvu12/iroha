# 05: Tabs without scrollbars, one styled Scroll Area

**What to build:** Rebuild the tab rows on the Provider, Pool and Gateway Key pages (and any other tab row) with UI SDK Tabs: a sliding selected indicator, keyboard arrows, and on narrow screens a sideways scroll with no visible scrollbar (the up/down arrow scrollbar in the Owner's screenshots must not appear at any width). Replace every scrolling region with UI SDK Scroll Area styled to Iroha (thin, appears on hover or scroll, edge fades where content continues): the pool route canvas and its side panel, the Requests drawer, the chat panel and its message list, pickers and long popups, code and JSON blocks, the sidebar. The route canvas pans and zooms without native scrollbars at all. Add a global fallback scrollbar style for anything left native.

**Blocked by:** 01

**Status:** done

Spec stories: 2, 3.

- [x] No browser default scrollbar visible anywhere in Chrome on Windows (the Owner's platform), light and dark
- [x] Tabs: indicator slides; arrows, Home and End move between tabs
- [x] Route canvas: drag to pan, zoom controls, no scrollbars

## Comments

**Built** (details in `docs/agents/architecture.md`, "UI ticket 05"):
- `ui/Tabs.tsx` on UI SDK Tabs: `RouteTabs` (tabs that are routes, each a router `Link`, the URL picks the tab, the routed content is its panel) and `Tabs`/`TabList`/`Tab`/`TabPanel` for state tabs, in two looks: `underline` and `segmented`. Both have a sliding `TabsIndicator`, with no transition on first placement or under reduced motion. The underline row sits in a Scroll Area with an invisible horizontal bar, so it scrolls sideways with an edge fade and never shows a bar. Moved to it: the Provider, Pool and Settings tab rows (the old `Tabs` in `ui/bits.tsx` is gone), the Requests drawer's Details/Attempts/Captured tabs (they were buttons with `aria-current`), the Route view's Route/Details/Captured switch (NavLinks) and Captured's Caller sent/Response switch (a hand-written `role="tablist"`). The Gateway Key page has no tab row, so there was nothing to add there.
- `ui/ScrollArea.tsx`, one shared wrapper on UI SDK Scroll Area. The thin thumb shows on hover or scroll, the edges fade (a mask driven by UI SDK's overflow variables, `scroll-fade-*` in `styles/index.css`), and it takes `axis`, `label`/`role="log"`, `bars={false}`, `stickToEnd` and `controller`. Used by: the sidebar (banner and nav scroll on short windows; health, Settings and Owner stay put), the chat message list (`role="log"` and `stickToEnd`, replacing the hand-rolled stick-to-bottom), the Requests drawer body, the Route view's Details/Captured body and phone list, both route side panels, `CodeBlock` (wraps by default, `nowrap` for snippets, `maxHeight={false}` for Captured), the Audit Entry JSON in `Changes.tsx`, and `ui/Table.tsx`'s sideways scroll (one line, which ticket 06 replaces anyway).
- `ui/Canvas.tsx` with the primitive `ui/canvas-primitive.ts`, built on UI SDK core `createViewport` (create-component path). It is a named, focusable frame that clips (`overflow: clip`) and never scrolls. You can drag empty space or use the wheel to pan, use Ctrl/⌘ + wheel or a pinch to zoom, press `+ − 0` with the frame focused, or use the Zoom out / level / Zoom in / Reset the view controls, and a card reached with Tab is panned into view. The Pool Route tab (it used native bars on both axes) and the Request Route view (it had a hand-rolled pan/zoom) both use it. Phones keep their vertical list.
- Global fallback in `styles/index.css`: a thin rounded `::-webkit-scrollbar` thumb with no track and no arrow buttons, for whatever still scrolls natively (the page itself, textareas). Firefox gets `scrollbar-width: thin`.

**Test-first:** I used the `tdd` skill. This run could not ask anyone, so I chose the seams myself: `ui/Tabs`, `ui/ScrollArea` and `ui/Canvas` (public components, no internals). Tabs and Canvas went red, then green. The ScrollArea tests were written after its first version, because Tabs needed it to exist. 4 + 4 + 4 tests, including agent tests (an agent picks a tab and presses Zoom in). Mutation check, with a throwaway script outside the repo: I broke 9 behaviours (zoom step, keys, clip, reset, Link render, indicator, region role, invisible bar on each axis) and the tests caught 8. The miss was the vertical `bars={false}` path, which had no test; I added one.

**Browser check** (headless Chrome over CDP with native scrollbars left on, the seeded server; light, dark, phone 390, narrow 320, short 1280x480 and 1280x360): `C:\Users\ADMIN\Desktop\nguyenvu\iroha-v2-notes\v2-ui\shots\05\` (the script is `check05.mjs` with `plan05.json`/`plan05b.json`). Every page audited for elements that scroll with a browser bar finds none (the first pass found `ui/Table.tsx`, which I then moved onto the Scroll Area). The audit also covered the pointer cursor (no issues) and sideways page scroll (none). At 320 px the Provider tab row scrolls sideways with a left fade, and End brings Settings into view. On both canvases Ctrl+wheel zooms (165%), a drag and the wheel pan, the page itself doesn't scroll, and Zoom in reads 120%. At 360 px tall the sidebar scrolls with a fade. The document's own scrollbar is the thin fallback.

**Left for others:**
- Popups belong to ticket 03, which is rebuilding them: the earlier-chats menu, the chat Picker panes, the Gateway Key ModelPicker and ScopeEditor lists, the `requests/menus.tsx` and Audit Entries submenus, the `ui/Dialog.tsx` body, and the Add-keys preview and results lists in `Keys.tsx`. They still scroll natively with the fallback style and should adopt `ui/ScrollArea` (see the architecture note).
- Tables: ticket 06's DataTable should keep using `ScrollArea` (`axis="x"`, or `both` with a sticky header).
- The composer textarea keeps native scrolling with the fallback style.
