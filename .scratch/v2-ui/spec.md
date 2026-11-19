# Iroha v2 UI: polish pass on UI SDK

The Owner's feedback after using v2 in production (2026-11-19). The admin UI in `web/` works, but it feels unfinished: controls lack animation, accessible behaviour and consistent interaction; tables differ from page to page; scrollbars and loading states look rough; and records that point at each other (a Request's Provider, Upstream Key, Gateway Key) can't be followed without leaving the page.

This pass rebuilds the UI's building blocks on **UI SDK** (`@ui-sdk/react` + `@ui-sdk/core`, Vercel Labs, headless and accessible) and **Skullet** (measured skeletons), adds one shared data table and a stack of side sheets for linked records, then gives every area its own animation pass. The backend changes only where a story says so (Pool logo).

The look stays the one in `.scratch/v2-gateway/design/v2-clean/` and the tokens in `web/src/styles/index.css`. This is not a redesign: same layout, colours, type and density, better behaviour.

## Decisions

- **UI SDK for every interactive part.** Dialog, Alert Dialog, Drawer, Menu, Select, Combobox, Tabs, Tooltip, Popover, Switch, Checkbox, Toast, Scroll Area, Pagination, Input, Field and Button come from UI SDK. Radix (`@radix-ui/*`) and Sonner are removed. A part UI SDK doesn't ship is built from `@ui-sdk/core` behaviours (its docs' "create a component" path), never hand-rolled with `role=` attributes.
- **Pin exact versions.** UI SDK is a beta that publishes several releases a day: pin `@ui-sdk/react` and `@ui-sdk/core` to the same exact version (`0.1.0-beta.12` was latest on 2026-11-19; no `^`). Upgrades are a deliberate ticket of their own, later.
- **Where agents read about UI SDK.** The docs that ship in `node_modules/@ui-sdk/react/docs/` for the installed version: `llms.txt` first, then only the component pages a task needs; `core.md` (300 KB) only by heading, with `rendering.md`, when building a missing part. UI SDK's agent skill is read from GitHub, not installed (the Owner hasn't added it to the Fleet): `vercel-labs/ui` at commit `8b452a3aa1`, `packages/core/skills/ui-sdk/SKILL.md` and its `references/` (build-interface, create-component, patterns, agent-ready, styles, testing). Follow its "Rules for every path".
- **No `web.css` look.** Iroha keeps its own styles: Tailwind 4 with the existing tokens, styled from UI SDK's `data-slot` and state attributes. Declare `@layer ui-sdk;` at the top of the global stylesheet, above `@import "tailwindcss"`.
- **One data table.** UI SDK has no table. The shared `DataTable` is a semantic `<table>` driven by TanStack Table (headless: sorting, filtering, selection, pagination state), with UI SDK parts for its controls (Checkbox, Menu, Pagination, Select, Scroll Area). Every table in the app uses it.
- **Skeletons from Skullet** (`skullet/react`, pin exact `0.0.3`): wrap real content with `data` and a `sample`, so the skeleton is measured from the real layout. Read its README in full (`node_modules/skullet/README.md`) before using it.
- **Results show where they happened.** A copy button turns into "Copied" in place; a save button shows saved state in place; a toggle shows its new state. A toast only when the place that caused it is gone (a dialog that closed, a page that navigated, a background job finishing) or for an error with nowhere else to go.
- **Linked records open in stacked side sheets** (Owner's design, below). Each sheet shows the record's information and an "Open page" button to its full detail page.
- **Pagination.** Numbered pages with a page-size picker on every table except the Requests feed, which keeps live updates at the top and loads older Requests as you scroll (new rows keep arriving; numbered pages would shift under the reader). The Owner can still switch Requests to numbered pages if they prefer; the DataTable supports both.

## User stories

1. As the Owner, every button, link, menu item, tab and clickable row shows a pointer cursor (Tailwind 4 dropped `cursor: pointer` on buttons).
2. As the Owner, the tabs on a Provider, Pool or Gateway Key page never show a scrollbar; when they don't fit on a narrow screen they scroll sideways with no visible bar, and the selected tab's underline slides to the new tab.
3. As the Owner, every scrolling region (route canvas, sheets, chat panel, pickers, tables, code blocks) uses one styled scrollbar that appears on hover or scroll, never the browser's default bars and arrows.
4. As the Owner, every page has a sensible width: every page, forms and settings included, uses the page frame (about 1280px), setting rows keep their controls to a sensible width, and nothing stretches across a wide monitor. (Owner, 2026-11-20, ticket 24: replaces "forms and settings sit in a readable column (about 768px)"; Login and Setup stay narrow centred forms.)
5. As the Owner, every table looks and behaves the same: header, sorting, a search box where the data is long enough to need it, row selection with a bulk-action bar where actions exist, row actions in a menu, empty and error states, a skeleton while loading, and pagination.
6. As the Owner, I can page through every table with numbered pages and choose the page size; my choice is remembered per table.
7. As the Owner, the Requests feed keeps showing new Requests live and loads older ones as I scroll.
8. As the Owner, loading states are skeletons measured from the real content, so nothing jumps when data arrives, and a refetch doesn't flash a skeleton.
9. As the Owner, when I copy something, the button itself says "Copied" for a moment; when I save a setting inline, the field shows it saved; I see a toast only when the place I acted from has gone away.
10. As the Owner, in a Request I can click its Provider, Upstream Key, Endpoint, Gateway Key or Pool and a side sheet opens with that record's information, its own linked records (clickable, opening the next sheet) and an "Open page" button to its full page.
11. As the Owner, sheets stack side by side: opening a linked record from a sheet slides a new sheet in from the right and focuses it, and older sheets are pushed left, off the screen if there's no room. Closing the top sheet slides it out and the previous one slides back into focus. Escape and Back close the top sheet only.
12. As the Owner, the open sheets are in the URL, so reload and Back/Forward keep them and I can share a link to the same view.
13. As the Owner, everywhere a record names another record (Requests, Attempts, Audit Entries, Model Pools' members, Gateway Key scopes, Upstream Keys' Endpoints, route views), the name is a link that opens its sheet.
14. As the Owner, a Model Pool's logo works with either a model maker (`openai`) or a website (`chatgpt.com`), shows the logo it found as I type, and says inline when none was found.
15. As the Owner, each area of the app has deliberate motion: popups grow from their trigger, sheets and dialogs enter and leave, lists add and remove rows smoothly, tab and segmented indicators slide, presses respond, and all of it holds still under reduced motion and never makes a frequent action feel slow.
16. As an agent operating the UI, every control has an accessible name and the keyboard reaches everything, so automated tests and agents can drive it.

## Stacked sheets (Owner's design)

```
[Request][Provider]            open Provider from the Request
[Request][Provider][Key]       open a Key from the Provider: Key is focused,
                               Request and Provider slide left, partly or fully off screen
[Request][Provider]            close Key: it slides out right, Provider slides back in
```

- Not nested: siblings in one row, the newest on the right and focused. The rest stay mounted and keep their scroll position.
- Opening a record that's already in the stack focuses it instead of adding a duplicate. Opening from a sheet that isn't the top one closes the sheets above it first.
- The Requests page's detail drawer becomes the first sheet of this stack. Any page can open a stack.
- A record sheet shows: name, logo, state, the key facts, its own linked records as links, the common actions (Test, enable/disable, copy), and "Open page".
- Built from UI SDK (Drawer or Dialog with non-modal presentation, or a part composed from core behaviours if neither fits); the docs decide which.

## Out of scope

- Visual redesign, new pages, new backend features beyond the Pool logo.
- Upgrading UI SDK past the pinned version.
- Adding the ui-sdk skill to the Fleet.

## Verification

Each ticket: `npm run build` and typecheck clean, tests for behaviour it adds (UI SDK's skill asks for at least the agent test from its agent-ready reference on new interfaces), and a check in headless Chrome in light, dark and phone width, with screenshots kept outside the repo. Nothing is pushed or deployed; the Owner's agent deploys the integration branch.
