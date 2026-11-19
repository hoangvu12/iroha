# Iroha v2 UI: design handoff

The source is the Zeron Design "Iroha v2 UI". This folder holds a PNG at 2x for each board (`NN-*.png`), `index.html` (every board as plain CSS, to use as a starting point but not as production code) and `tokens.json`.
The copy uses GLOSSARY.md terms exactly: Provider, Endpoint, Shape, Upstream Key, Key State, Model Gap, Model Pool, Gateway Key, Request, Attempt, Failure Rule, Caller.

## Boards

| File | What it shows |
|---|---|
| 01–03 | Login, first visit (set password), wrong password |
| 04 | Provider detail, **Keys** tab, 3 rows selected so the bulk bar shows (the main screen) |
| 05 / 12 | Paste-keys dialog: parse preview, then per-item results after add + test |
| 06 | **Test** tab: setup column (model, key, Shape, snippet) + streamed chat + tool-call check result |
| 11 | Test tab, failed test with the Attempt explanation |
| 13 | Model picker popover (shared by Test panel, Pool members, Gateway Key narrowing) |
| 10 / 07 / 09 | Endpoints (+ inline rename editor, Provider settings), Models (+ override row), Rules |
| 08 | Providers page with a **Model Pool** selected (ordered members) |
| (canvas only) | Provider rail while searching (“mi”). It isn't exported because it's a component state. |
| 14 / 15 / 16 | Gateway Keys list, new-key dialog (scope + model narrowing), just-created state |
| 17 / 18 | Requests live feed (full width) and the split view with a Request open |
| 19 / 20 | Request detail: Captured tab and Logs tab |
| 21 | States board: loading, empty, no match, error, destructive confirm, bulk-result toast, paused feed, revoke |
| 22–24 | Dark mode: Keys, Requests detail, failed test |
| 25–28 | Phone: Providers, keys as cards in select mode, Requests cards, Request detail sheet |

## Direction

Calm, dense and technical, like a quiet instrument panel, not a dashboard. It has one accent (ai-indigo), used only for actions, selection and links. Colour carries state and nothing else. There are no charts, logos or decorative cards.

## Tokens (`tokens.json`, light / dark)

| Token | Light | Dark | Use |
|---|---|---|---|
| bg | #F5F6F8 | #0D0F13 | app background |
| panel | #FFFFFF | #14171C | tables, dialogs, rails |
| sunken | #F0F2F5 | #1A1E24 | table header, segmented track, summary boxes |
| hover | #EBEEF2 | #20252C | row/option hover |
| line / line-strong | #E2E5EA / #CBD0D8 | #252A32 / #353B46 | dividers / control borders |
| fg / fg2 / muted | #14171C / #454C57 / #626A76 | #E7E9ED / #B4BAC4 / #8C939E | text levels |
| accent / accent-soft / on-accent | #3A49B8 / #ECEEFA / #FFF | #8A98FF / #1C2140 / #0D0F13 | primary, selection |
| ok-bg / ok-fg | #E3F3E8 / #1B7339 | #12261A / #6FCF92 | Key State active, 2xx, passed |
| warn-bg / warn-fg | #FBF0D9 / #865600 | #2A2010 / #EDB65A | cooling, capture on, 503 everything cooling |
| err-bg / err-fg | #FBE5E3 / #B1261A | #2C1514 / #FF8C80 | invalid, 4xx/5xx, destructive |
| off-bg / off-fg | #ECEEF1 / #565D68 | #21252C / #9BA2AD | disabled, retry elsewhere |
| gap-bg / gap-fg | #F0E9FB / #6A3DB3 | #221A33 / #BA9EF4 | Model Gap |
| code | #F3F4F7 | #0F1216 | code/snippet/JSON blocks |
| scrim | #14171C66 | #00000099 | dialog overlay |
| shadow-sm / shadow-lg | #14171C1F / #14171C40 | #00000066 / #000000B3 | segmented thumb / dialogs |
| clear | #00000000 | | transparent |

These map straight onto shadcn CSS variables: `--background`=bg, `--card`/`--popover`=panel, `--muted`=sunken, `--border`=line, `--input`=line-strong, `--primary`=accent, `--accent`=hover, `--destructive`=err-fg. Add `--ok/--warn/--err/--off/--gap` pairs for the badges. Dark mode is a `.dark` class that the top-bar moon/sun toggle sets. It defaults to the system setting and is remembered in localStorage.

**Type:** IBM Plex Sans for the UI and IBM Plex Mono for secrets, model IDs, Endpoint handles, rule names, numbers, durations, times and JSON. Sizes are 12 (labels, meta, table secondary), 13 (table body, UI default), 14 (mobile body), 16 (dialog titles), 20 (page / Provider title, −0.3 letter-spacing). Weights are 400, 500 (names, buttons) and 600 (titles, headers). Numbers use mono, so they line up without tabular-nums tricks. Nothing goes below 12 px.

**Spacing:** a 4 px scale. Page padding is 20–24 and section gap 16. Rows are 36 (keys), 40 (Gateway Keys) and 48 (Requests, two-line). Controls are 30 tall (buttons, inputs, chips), 36 on login and 38–40 on mobile.
**Radius:** 4 badges/chips, 6 controls, 8 panels/tables, 10 dialogs, 14–16 phone sheets.

## Layout rules

- **Shell:** a 48 px top bar (wordmark, three tabs with a 2 px accent underline, a "Jump to…" box with Ctrl K, the theme toggle and the Owner menu with logout). There's no sidebar, so tables get the full width.
- **Providers page = rail + detail.** The rail is 240 px: search, then PROVIDERS (name + key count), then MODEL POOLS (name + member count). It is the Providers "list": the Owner types and presses Enter. The selected item gets accent-soft + accent text. The landing route opens the last-visited Provider, and `/providers` with nothing selected focuses the rail search. Pools live in the same rail and open a Pool detail in the right pane.
- **Provider detail:** title row (name, display name, enabled badge, Test, ⋯ menu for disable/archive/budget). Under it is a one-line summary of clickable counts (`31 active · 5 cooling · 3 invalid · 3 disabled · 9 Model Gaps`), and each count applies that filter to the Keys table. Tabs follow: **Keys · Test · Endpoints · Models · Rules**, with counts in mono.
- **Tables:** one fill column, the rest fixed. Numbers are right-aligned in mono, and a `–` replaces zeros where noise hurts (Gaps). Long text is truncated with an ellipsis plus a title tooltip, and it never wraps inside 36 px rows. The header row and toolbar are sticky, and the body is virtualised (TanStack Table + TanStack Virtual) for 200 keys / 2k models.
- **Dialogs** are centred with a scrim. Their footer sits on `sunken` with a top border: the left side holds a hint or summary, the right side holds Cancel + primary.
- **Phone (<768 px):** a bottom tab bar replaces the top tabs, the rail becomes the Providers screen, tables become cards (name + badge, reason, secret + copy, stats), bulk actions move to a bottom selection bar, and detail panels become bottom sheets. On phones the Provider tabs scroll horizontally.

## Components (shadcn/radix base)

TopBar · ProviderRail (search, grouped list) · StateBadge (dot + word, tone = ok/warn/err/off/gap) · StatusPill (HTTP code) · AttemptDots (one 10 px square per Attempt, coloured by outcome) · DataTable (sort, per-column filter, row select, sticky header, virtual body) · FilterChip (label + value + chevron, accent when active) · BulkBar · Segmented · Combobox/ModelPicker (cmdk, grouped, virtualised) · CodeBlock with tabs + Copy · ChatThread (user bubble right, assistant plain, meta line, streaming caret) · ToolCheckCard · AttemptExplanation (summary line + Attempt rows, expandable body/headers; shared by the Test panel and Requests) · ScopeBuilder (two-pane) · KeyReveal (masked secret, eye, copy) · Toast (sonner) · ConfirmDialog · Skeleton rows · EmptyState.

## Interaction details

**Upstream Keys table**
- Search matches name, secret, reason and Endpoint. Each column header has sort (click) and a filter icon (popover) where it makes sense: Key State (multi-select of states, plus a reason text filter), Endpoint, Last used (range), Req/Fail 24h (≥ n), Gaps (has / none). Active filters show as accent chips in the toolbar and live in the URL.
- Default sort is Key State severity (invalid → cooling → disabled → active), then Fail 24h. The shown board is sorted by Fail 24h ↓.
- Selection uses checkboxes, shift-click for ranges, Ctrl/Cmd-A when the table has focus and "Select all 42" (it means all *filtered* rows). Once anything is selected, the bulk bar replaces the toolbar: Test, Enable, Disable, Set Endpoints (popover with Endpoint checkboxes + "All Endpoints"), Clear Model Gaps, Copy keys (newline-separated secrets, or `name<TAB>secret` with Shift), Delete (confirm dialog). Esc clears the selection.
- Every bulk action calls the bulk admin API and reports per item in a toast ("Disabled 2 of 3 · team-7 already disabled"). Its Details link opens the per-item list. Undo appears when the Audit Entry can be reverted.
- The secret is masked to its last 4 characters. The eye reveals it in place (one row at a time) and copy works without revealing it. The row ⋯ menu offers Test this key, Test in panel (opens the Test tab pinned to this key), Edit (name, secret, Endpoints), View Model Gaps (popover list with per-gap clear) and View Requests (Requests filtered to this key).
- Cooling shows the until-time. On hover a tooltip shows a countdown and the scope (whole key, or one model, e.g. "qwen3-max only").
- **Paste keys:** a textarea with line numbers that accepts `secret` or `name␠secret` per line. It shows a live parse summary (new / duplicate / blank). Duplicates are highlighted and skipped, the prefix names unnamed keys (the next free numbers), there's an Endpoint restriction, and "Test each key after adding" is on by default. Submitting turns the dialog into a per-item results list (added / invalid / skipped + test outcome).

**Test panel**
- Model picker: cmdk-style, with Pools first, then the Provider's models, scope chips All / this Provider / Pools, and "show hidden". It's virtualised, ↑↓/Enter, and shows metadata on the right. It also accepts an unlisted model ID ("Use 'x' as typed", since unlisted models are still forwarded).
- Key: "Any key (like a Caller)" plans keys exactly as live traffic would; "Pin one key" sends every Attempt to that key. Shape is a 4-way segmented control, with a hint saying whether the path is passthrough or translated.
- Snippets in curl / Python / TypeScript follow the chosen Shape and model and use `$IROHA_KEY`. Copy shows a 1.5 s "Copied" state.
- Chat: Enter sends, Shift+Enter adds a new line, Stop while streaming, New chat resets. Each assistant turn has a mono meta line (key · Endpoint · TTFT · total · tokens) and a link to its Request. Tool-call check sends a sample `get_weather` tool and shows pass/fail with the raw tool call.
- Failure: the AttemptExplanation card sits inline in the thread, with the first failed Attempt expanded. Quick actions are Retry, Retry pinned to a key, and Clear Model Gap on <key> when a gap was learned. Test traffic is recorded under the **Test** caller.

**Gateway Key dialog**
- Name, then Access as a segmented control: **All access** (hides the builder) or **Chosen Providers and Pools**.
- Builder left pane: a searchable checklist of Providers (with model counts) and Pools. Right pane: what's chosen, one row each. A Provider row has a mode select, **All models** (includes future ones) or **Only some models**. Choosing the latter expands an inline virtualised model checklist with search, "Select N matches" and chips for the chosen models. A Pool row is always the whole Pool.
- The capture switch (off by default) explains the 3-day retention.
- The footer summarises the scope in one sentence. Create turns the dialog into the just-created view: the key in a large mono box with a primary Copy, the base URLs to give the Caller, and "Copy key + base URL". The new row flashes green in the list behind. Edit reuses the same dialog with a Revoke link bottom-left.

**Requests**
- The live feed streams in (SSE) at the top, and new rows flash `ok-bg` for 1.5 s. If the Owner scrolls down or presses Pause, arrivals collect in a "14 new Requests · resume live" pill. Filters (Caller, Provider/Pool, model, status, time range, Request ID) combine and live in the URL.
- Each row is two lines: Caller / route · requested model / "→ Provider · Endpoint · key · wire model" · Shape in / out · TTFT · total · tokens in → out · Attempt dots + count. If nothing was tried, the served line reads "nothing tried · every key cooling until T" in warn colour.
- Clicking a row opens the split view (the feed drops the Shape/TTFT/Tokens columns). The detail panel holds the id + copy, the status, a permalink and close, the one-line summary in a sunken box, a 2×3 fact grid, and tabs **Attempts · Captured · Logs · Raw**. The Captured tab only appears when capture was on, with a retention banner. Links go to the key, Provider and Gateway Key. ↑/↓ moves between Requests while the panel is open, and Esc closes it.

## States (board 21)

- **Loading:** skeleton rows in the table's own layout, never a spinner. The data stays in place on refetch.
- **Empty:** one sentence plus the action that fills it (Add keys / Add keyless key).
- **No match:** names the active filters and offers Clear filters.
- **Error:** shows the admin API's machine code and hint verbatim, a Retry button, and the last good data (marked stale) underneath.
- **Destructive** actions (delete keys, revoke Gateway Key, reset discovered models) confirm in a dialog with a filled red button. Everything else acts immediately and confirms with a toast.

## Motion

Keep it minimal: 120–160 ms fades or transforms on popovers and dialogs, a 1.5 s flash on new rows, and a pulsing Live dot. Nothing animates on keyboard actions, and `prefers-reduced-motion` turns everything off.
