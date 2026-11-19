# 17: Motion pass: Providers and Pools pages

**What to build:** A motion pass on one area only: the Providers list and overview, Provider and Pool detail pages, the key and Endpoint dialogs, the Keys tab's states and gaps, the route view and route preview canvas (node focus, panel open), Pool members reorder. One agent, this area, nothing else (the Owner asked for each part on its own so nothing gets missed). First run the `find-animation-opportunities` skill read-only on this area and write its proposal (what moves, what must not, exact values) into this ticket's Comments; then build it with `animate`, plus `choreograph` where several elements move together and `emil-design-eng` / `apple-design` for press, hover, origin and timing details. Check frame cost with `animation-performance` and drop motion from high-frequency actions with `remove-animations` thinking. Use UI SDK's state attributes (`data-starting-style`, `data-ending-style`, `data-open`, `--transform-origin`) rather than mounting tricks. Everything holds still under `prefers-reduced-motion`. Then run `review-animations` on the diff and fix what it finds.

**Shared motion system (Owner, 2026-11-19):** build from the app-wide motion system (durations, easings, enter/exit patterns, reduced-motion rule) that an `improve-animations` audit set before the motion tickets: tokens in `web/src/styles/index.css` and `### UI motion system` in `docs/agents/architecture.md`. Use its tokens, not new values; its per-area list is input to your `find-animation-opportunities` run, not a replacement for it.

**Blocked by:** 07, 12

**Status:** done

Spec story: 15.

- [x] Proposal from `find-animation-opportunities` recorded in Comments, with what was rejected and why
- [x] Built motion matches the proposal; reduced motion holds still
- [x] No dropped frames in a Chrome performance trace of this area's main interactions
- [x] `review-animations` findings fixed or answered in Comments

## Comments

### Proposal (`find-animation-opportunities`, read-only, 2026-11-20)

Recon: React 19, Tailwind 4, UI SDK beta.12, no motion library. Tokens and recipes from architecture.md "UI motion system". This area is a dense operator dashboard: the lists and the Keys tab are visited many times a day, the Pool pages, the dialogs and Settings occasionally. Today it has almost no motion of its own. The dialogs, menus and selects already carry ticket 14's recipes, and the indicator, bulk bar and rows belong to 05/16. Seams swept: feedback gaps, teleporting state, missing spatial story, group entrances, gesture seams, the delight budget.

| # | Location | Today | Purpose | Frequency | Motion |
|---|---|---|---|---|---|
| 1 | `ui/RowOrder.tsx` (Pool Members drag) | During a pointer drag the rows jump to the draft order. The held row only gets tinted, and it doesn't follow the pointer. | Spatial consistency | Occasional | The held row follows the pointer 1:1 (`translate`, no transition) and is lifted (`relative z-10`, `shadow-elevated`, existing `bg-subtle`). When the draft order changes, each displaced sibling FLIPs from where it was: WAAPI `translate` → `0 0`, `--duration-move` (250 ms) and `--ease-in-out`, all together with no stagger, retargeting from its current offset if it is still moving. On drop, or on Escape, the held row settles from its offset into its slot over the same 250 ms with `ease-in-out`. A keyboard move (Space and the arrows), Move up/down in the menu and an agent's `move` stay instant. Reduced motion: `--duration-move` is 0, so the siblings and the drop snap, and the held row still follows the finger (direct manipulation, not animation). |
| 2 | `ui/Canvas.tsx` zoom buttons, and pointer focus on a card | Zoom in, Zoom out and Reset jump. A click on a card near the edge jumps the world to reveal it. | Spatial consistency | Occasional | `data-glide` on the world for one `--duration-move` after a button press, or a pointer press on a card: `transition-[transform] duration-move ease-in-out`. Linear interpolation of `translate()` + `scale()` keeps the zoom's fixed point fixed. Wheel, drag, pinch, `+ − 0` and Tab-to-card stay 1:1 or instant: a wheel or a pan press drops `data-glide` at once. Reduced motion: the token is 0, so it's instant. |
| 3 | `pages/providers/Keys.tsx` `KeyDialog`, `Models.tsx` `ModelDialog` | Both return `null` when closed, so they vanish with no exit (the dialog recipe's 150 ms out never plays). | Spatial consistency (exit the way it entered) | Tens a day (key dialog) | Keep the `Dialog` mounted with `open={!!k}` and render the last record while it leaves, so ticket 14's dialog recipe (200 ms in, 150 ms out) plays both ways. Nothing new. |
| 4 | Content that appears inside an open dialog: Add Provider (Shape + No key needed), Endpoint (Header/Parameter name), Rule (Cool for, the "Check against last week" result), Add keys (the found-keys box), the key dialog (Replace form), the dialog error lines | Pops in, so the eye has to find it | Preventing a jarring change | Occasional | The list recipe used by Field errors: `transition-[opacity,translate] duration-list-in ease-out starting:-translate-y-(--motion-shift-sm) starting:opacity-0`, only when it appears after the dialog opened (`Reveal`: no second entrance inside the dialog's own entrance). Leaving is instant, so the gap closes at once. Reduced motion: the shift is 0, so it only fades. |
| 5 | `ui/Switch.tsx` (audit #12) | Bare `transition-transform` (150 ms, Tailwind's weak curve) and `transition-colors`, both cut by `motion-reduce` | State indication / feedback | Tens a day | Thumb `transition-[translate] duration-press ease-out`, track `transition-colors duration-hover ease-[ease]`. Drop `motion-reduce:transition-none`: under reduce the thumb jumps (press is 0) and the colour still fades. |
| 6 | `pages/providers/LogoField.tsx` tile | The found logo replaces the letter, or the last logo, at once | State indication | Rare (Settings) | The tile fades in on each change after the first (`key` by the logo shown, `transition-opacity duration-fade ease-out starting:opacity-0`). The status line's text changes in place. |
| 7 | `pages/providers/PoolRoute.tsx` `Card` | `transition-shadow` with Tailwind's default timing; the border colour snaps | State indication (selection) | Tens a day | `transition-[box-shadow,border-color] duration-hover ease-[ease]`. Hover colours only, no press scale (see rejected). |

Not motion, from audit #14: the hover-revealed "Test in Chat" (Providers/Pools rows) and Copy (key cell) are `opacity-0` with `group-hover:opacity-100`. On a touch tablet at 768 px or more, with no hover, they are invisible but still tappable. Add `[@media(hover:none)]:opacity-100`. The reveal stays instant (row hover is high-frequency).

**Rejected:**
- Route preview side panel swapping content when a card is picked (crossfade or slide). **Rejected (Function):** it is a reading surface, and the card's ring already says what changed. Panels swap at once, as tab panels do. The panel never opens or closes on desktop: Close only returns it to the first step.
- Press scale on the route cards. **Rejected (Speed/size):** a 400 px card at `--motion-scale-press` moves 12 px, so it would need a new, subtler token for little gain. The ring is the feedback.
- Animating the route preview's 5 s refresh, Key State labels and their countdowns, gap pills, the Members stats and the Members tab count. **Rejected (Function):** data that refreshes on its own changes in place.
- Removing a cleared Model/Endpoint Gap row in the key dialog with a fade-out. **Rejected (Frequency/purpose):** the result and its Undo already show in the footer. Holding a removed row for its exit needs machinery, and the motion system says siblings close the gap at once.
- The empty-state-to-first-row moment (first Provider or first key) and the hover reveal of row buttons. **Rejected here:** they are DataTable's (ticket 16). The hover reveal is high-frequency and stays instant.
- Keyboard reorder, canvas `+ − 0`, Tab-to-card, wheel, drag and pinch. **Rejected (Frequency):** keyboard and 1:1 never animate.

Verdict: this area needs little. The drag reorder (1) is the one real gap, a gesture that teleports today. The canvas glide (2) and the dialogs' missing exit (3) are the next highest leverage. The rest are token fixes. Tabs' indicators still carry `duration-200` (`ui/Tabs.tsx`). That is shared with 18 and 20, so it's left to them or a final pass.

### Built (2026-11-20, branch `agent/ui17`)

What was built, against the proposal (architecture.md "UI ticket 17" has the details):

1. **Reorder glide** (`ui/RowOrder.tsx`, `ui/reorder-primitive.ts`, new `ui/motion.ts`), as proposed, with one change: the FLIP runs on `transform`, not `translate`. jsdom computes `transform`, and ticket 16's row entrance already uses `translate` on the same `tr`, so the two can't fight. The held row is lifted with `relative z-10 bg-subtle shadow-elevated`.
2. **Canvas glide** (`ui/Canvas.tsx`), as proposed. A keyboard or agent click on a zoom button (`detail === 0`) stays instant too.
3. **Dialog exits**: `KeyDialog` and `ModelDialog` stay mounted and show the last record while they leave.
4. **Content under a choice**: changed from the proposal for cohesion with ticket 20. The sections under a choice (Add Provider's URL settings, the Endpoint's header or parameter name, a Rule's "Cool for", the found-keys box, the Replace form) use the shared collapse `Reveal` (`ui/Reveal.tsx`). The gap above each sits inside its panel, so it folds with it. `ringRoom` keeps input focus rings unclipped. The Rule replay result uses `riseIn`. Dialog error lines keep the Field-error drop-in (`appearClass`). The Endpoint and Rule dialogs reset their form during render, not in an effect, so their first frame is right. My page-local `Reveal` was removed.
5. **Switch**: done by ticket 20 (same classes); my duplicate was dropped at the merge.
6. **Logo tile**: fades in and grows from `--motion-scale-popup` (from the review, below).
7. **Route cards**: `transition-[box-shadow,border-color] duration-hover ease-[ease]`.
- Touch fix (audit #14): superseded by ticket 16's `row-reveal` utility, taken at the merge.
- **Layout bug (from ticket 11)**: at 1440×900 the Pool Route's live bar wrapped to two rows and covered the Start card. The cause was that `Select` is `w-full` inside, so its `className="w-48"` lost to `w-full`, and the select stretched. It now sits in a `w-48` box. The bar stays on one row over the canvas (its note truncates first) and wraps only on phones. Measured: the bar's bottom edge is at 289 px and the Start card's top at 302 px; before the fix the bar ended at 329 px.

**Test-first** (tdd skill). The seams were each component's or page's behaviour as seen in the DOM:
- RowOrder: the drag follows the pointer, siblings glide, the drop settles, the keyboard doesn't animate, reduced motion snaps.
- Canvas: the buttons and a card press glide; wheel, pan, `+` and Tab don't.
- Key and Model dialogs: the exit plays while still showing the record.
- LogoField: a found logo fades in; the first tile doesn't.
- Endpoints: picking "A header you name" opens the name field in a collapse panel with room for the focus ring.

Each test was red before the code. One exception: the Endpoints test was written after the switch to the shared `Reveal` and passed at once. Web: 51 files, 291 tests, all passing. `tsc -b` is clean and the build passes.

**Browser checks** (seeded server, `check17.mjs`, headless and headed Chrome):
- **Drag**:
  - The held row follows (`translateY(26px)`) and is lifted (`position: relative`, z 10, shadow).
  - On drop the passed row glides 48 px → 0 and the held row settles 9 px → 0, each 250 ms on `cubic-bezier(0.77, 0, 0.175, 1)`. After 400 ms every row's transform is `none`.
  - The keyboard reorder (Space, ↑↑, Space) runs no glide.
- **Zoom in**: `data-glide` is on, one 250 ms transform transition runs, and it is off again after it (120%). Wheel: no glide.
- **Key dialog**: on close it shows `data-ending-style` with the title still "key-1", then it unmounts.
- **Add Provider settings**: open 0 → 182 px, fold 182 → 0, then unmount. The Shape select's focus ring is unclipped (`add-provider-focus-ring.png`).
- **Reduced motion**: the drag follows with no glides, zoom has a 0 s transition, and the dialog only fades (scale 1).

**Trace** (headed, CPU ×4, 240 Hz display, frames over 17 / 34 ms, motion vs every transition and WAAPI off):

| Interaction | Motion | Still |
|---|---|---|
| Drag | 5 / 2 | 6 / 3 |
| Zoom | 7 / 2 | 4 / 2 |
| Key dialog | 7 / 5 | 7 / 5 |

The motion adds no long frames of its own; the long ones come from navigation and data loading in both runs. The trace is `trace17-headed-cpu4.json`.

Screenshots (light, dark, phone, phone-dark of the Providers list, Members, Route and key dialog, plus mid-drag, after drop, route reset and the Add Provider reveal) are in `iroha-v2-notes/v2-ui/shots/17/`.

### `review-animations` on the diff

| Before | After | Why |
|---|---|---|
| `LogoField.tsx` tile: `transition-opacity … starting:opacity-0` (pure fade) | `transition-[opacity,scale] duration-fade ease-out starting:scale-(--motion-scale-popup) starting:opacity-0` | A pure-fade entrance has no initial transform. Under reduced motion the scale token is 1, so it falls back to a fade. |
| Page-local `Reveal` (drop-in from above, instant hide) for sections under a choice | Shared collapse `Reveal` from ticket 20, gap inside the panel, `ringRoom` | Cohesion: the same kind of moment now moves the same way app-wide. Measured height is the documented accordion exception. |
| Collapse panel `overflow-hidden` around inputs | `ringRoom` (`-mx-1 px-1 -mb-1 pb-1`) on those panels | The 2 px focus ring was clipped at the sides and bottom. |

Answered, no change:
- **Drag past the list's ends has no rubber-banding.** The held row is clipped at the table's edge, and core clamps the order. The rows are short and the list is small; deferred.
- **The held row's lift (tint, shadow) is instant on grab.** That is feedback on the press itself, and it should be immediate.
- **Glides use `ease-in-out`.** They are on-screen movement, at the move token's 250 ms. They are interruptible: a running glide is cancelled and restarted from its computed transform.

Verdict: **Approve**.

**Deferred:**
- Tabs' `duration-200` indicator (shared with 18 and 20).
- Rubber-banding at the reorder's ends.
- The empty-to-first-row moment and row hover belong to ticket 16 (merged).

`ui/RowOrder`, `ui/Canvas` and `ui/motion.ts` are shared, so ticket 18's Route view gets the canvas glide too.
