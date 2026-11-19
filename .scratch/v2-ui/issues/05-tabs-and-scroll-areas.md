# 05: Tabs without scrollbars, one styled Scroll Area

**What to build:** Rebuild the tab rows on the Provider, Pool and Gateway Key pages (and any other tab row) with UI SDK Tabs: a sliding selected indicator, keyboard arrows, and on narrow screens a sideways scroll with no visible scrollbar (the up/down arrow scrollbar in the Owner's screenshots must not appear at any width). Replace every scrolling region with UI SDK Scroll Area styled to Iroha (thin, appears on hover or scroll, edge fades where content continues): the pool route canvas and its side panel, the Requests drawer, the chat panel and its message list, pickers and long popups, code and JSON blocks, the sidebar. The route canvas pans and zooms without native scrollbars at all. Add a global fallback scrollbar style for anything left native.

**Blocked by:** 01

**Status:** open

Spec stories: 2, 3.

- [ ] No browser default scrollbar visible anywhere in Chrome on Windows (the Owner's platform), light and dark
- [ ] Tabs: indicator slides; arrows, Home and End move between tabs
- [ ] Route canvas: drag to pan, zoom controls, no scrollbars
