# 20: Motion pass: Gateway Keys and Settings

**What to build:** A motion pass on one area only: the Gateway Keys list and key page, the new-key dialog and its reveal-once secret, the scope editor and model picker, Settings (Admin Tokens, Audit Entries and revert, Sign-in), the states page. One agent, this area, nothing else (the Owner asked for each part on its own so nothing gets missed). First run the `find-animation-opportunities` skill read-only on this area and write its proposal (what moves, what must not, exact values) into this ticket's Comments; then build it with `animate`, plus `choreograph` where several elements move together and `emil-design-eng` / `apple-design` for press, hover, origin and timing details. Check frame cost with `animation-performance` and drop motion from high-frequency actions with `remove-animations` thinking. Use UI SDK's state attributes (`data-starting-style`, `data-ending-style`, `data-open`, `--transform-origin`) rather than mounting tricks. Everything holds still under `prefers-reduced-motion`. Then run `review-animations` on the diff and fix what it finds.

**Shared motion system (Owner, 2026-11-19):** build from the app-wide motion system (durations, easings, enter/exit patterns, reduced-motion rule) that an `improve-animations` audit set before the motion tickets: tokens in `web/src/styles/index.css` and `### UI motion system` in `docs/agents/architecture.md`. Use its tokens, not new values; its per-area list is input to your `find-animation-opportunities` run, not a replacement for it.

**Blocked by:** 08

**Status:** done

Spec story: 15.

- [x] Proposal from `find-animation-opportunities` recorded in Comments, with what was rejected and why
- [x] Built motion matches the proposal; reduced motion holds still
- [x] No dropped frames in a Chrome performance trace of this area's main interactions
- [x] `review-animations` findings fixed or answered in Comments

## Comments

### Proposal (`find-animation-opportunities`, read-only run before building)

Recon: a crisp operator dashboard. Tokens and recipes from architecture.md "UI motion system"; no motion library. Frequency: the Gateway Keys list and Settings tables are tens a day; the dialogs (new key, access, model picker, new token, password) are occasional; the reveal-once secret is rare. Input from `motion-audit.md` §20 was re-checked: the Revoked keys fold already uses `Disclosure`'s collapse recipe, and the Audit Entries chevron clash (#6) was fixed by ticket 08 (DataTable rotates the svg with `[&_svg]:transition-[rotate] duration-collapse`), so neither needed work here.

| # | Location | Today | Purpose | Frequency | Motion (tokens) |
|---|---|---|---|---|---|
| 1 | `gateway-keys/CreateDialog.tsx` created view, `settings/AdminTokens.tsx` created view | The form swaps to the secret at once | Preventing a jarring change; a little delight at a rare moment | Rare | Title, text and secret enter on one frame: `transition-[opacity,translate] duration-list-in ease-out`, from `starting:translate-y-(--motion-shift-sm) starting:opacity-0`; the Gateway Key's check badge `transition-[opacity,scale] duration-dialog-in ease-out` from `scale-(--motion-scale-popup)`. No stagger (the key must be there to copy at once), no typewriter. Reduced motion: a plain fade (shift 0, scale 1). |
| 2 | `gateway-keys/ScopeEditor.tsx` "Only some" checklist | `{!draft.all && …}`: the dialog jumps ~300 px | State indication; preventing a jarring change | Occasional | Collapse recipe: `h-(--collapsible-panel-height) transition-[height] duration-collapse ease-out`, 0 on the starting and ending style; open on first paint shows at once. Reduced motion: `--duration-collapse` 0, so it jumps. |
| 3 | `gateway-keys/ModelPicker.tsx` "Only these" list | Same jump in the nested dialog | Same | Occasional | Same recipe. No push-back of the dialog under it. |
| 4 | `settings/AuditEntries.tsx` `Details` | Details appear at once under the row | Preventing a jarring change | Tens a day at most, by pointer | Proposed as a fade only (`duration-fade`); changed to the row recipe after review (see below). Never height: the rows under it move at once. |
| 5 | `ui/Switch.tsx` (key page's capture switch) | Bare `transition-transform` (150 ms, default curve) and `motion-reduce:transition-none` | Feedback, on the tokens (audit #12) | Occasional | Thumb `transition-[translate] duration-press ease-out`; track `transition-colors duration-hover`. |
| 6 | `ScopeEditor.tsx` "Models of <handle>" button | No press feedback | Feedback | Occasional | The `press` utility (scale 0.97 on `duration-press`, back on `duration-release`). |

Not motion, from the same sweep: the hover-revealed copy buttons in Gateway Keys and Admin Tokens rows never showed on touch (audit #14). They now show where nothing hovers (`[@media(hover:none)]:opacity-100`). The reveal stays instant.

Rejected:
- Row hover reveal of the copy buttons fading (`transition-opacity`): **tens a day; row hover is instant** (and `press`'s transition list would collide with a second one, since `cn` has no merge).
- Model chips entering and leaving as models are ticked: **high frequency within the task, and the pointer is on the list, not the chips**. Colour-only draft.
- The key page's "Captured Requests" row entering when capture is switched on (first proposed, dropped while building): **rare, and the result already shows at the switch (`SaveStatus`)**. An enter with no matching exit would be lopsided.
- Revert in Audit Entries: **the result changes in place through `SaveStatus` (shared, already fades in)**. Nothing more.
- Sign-in's signed-in browsers, Last used and Requests counts, sorting, filters, pages, Settings tab panels: **data or high-frequency surfaces**. They change at once.
- Rows leaving after revoke or delete, bulk bar, "Copied" morph: **generic DataTable / shared CopyButton motion, ticket 16's**.
- `/states`: gets whatever the shared parts do; nothing page-specific.

### Built

- `web/src/ui/Reveal.tsx` (new): `Reveal` (trigger-less Collapsible with the collapse recipe, named by `label` for agents), `collapsePanelClass`, `riseIn`.
- `ScopeEditor` and `ModelPicker` put their sections in `Reveal` (spacing moved from `mt-4` to an inner `pt-4`, so the panel's 0 height hides it). "Models of" got `press`.
- `CreateDialog` (Gateway Key) and Admin Tokens' `CreateDialog`: created view as row 1. The Gateway Key's body is keyed (`key="created"`): without it React reused the form's body `<div>`, so nothing entered. The browser samples caught it; a test now pins it.
- Audit Entries `Details`: `riseIn`.
- `Switch`: tokens as row 5, plus `ease-[ease]` on the track's colour.
- Row copy buttons: shown where nothing hovers.
- `docs/agents/architecture.md`: `### UI ticket 20: Gateway Keys and Settings motion`.

Test-first with the `tdd` skill (red, then green, one slice at a time). The seams follow ticket 14's precedent: the real markup of each page in jsdom. There was no Owner to confirm them in this run. Tests: `pages/gateway-keys/motion.test.tsx` (collapse recipe on both sections, no growth when open on first paint, press, created view rising and not reusing the form's element), `List.test.tsx` and `AdminTokens.test.tsx` (touch shows the copy button; the token's created view), `AuditEntries.test.tsx` (details enter by the row recipe, no height), `ui/controls.test.tsx` (Switch tokens). `npm --prefix web run build` passes; `npm --prefix web test`: 44 files, 231 tests pass.

### Browser checks (`iroha-v2-notes/v2-ui/shots/20/`)

- Screenshots: light, dark and phone (390 px) of the Gateway Keys list, the new-key dialog on "Only some", Audit Entries with details open (`10-`–`15-*`), plus the model picker on "Only these", both created views and the details after entering (`01-`–`03-`, `16-`).
- Per-frame samples (`trace20.mjs`, Chrome): "Everything" folds 254→0 px in ~160 ms and unmounts at ~210 ms; "Only some" grows 0→299 px in ~170 ms; the dialog opening on "Only some" doesn't grow; "Only these" grows 0→287 px. After it has finished opening it steps to 371 px when the model list arrives, which is data and has height auto. The created view rises 4→0 px while fading 0→1 in ~200 ms. Details rise the same way in 190 ms.
- Reduced motion (emulated): the sections jump (0 ms); the created view fades with no shift; tokens read `--duration-collapse 0s`, `--duration-press 0s`, `--duration-list-in .2s`, `--motion-shift-sm 0px`.
- Performance: headed Chrome, 4× CPU, every step traced, with a motion-off comparison (`frame-stats-headed-cpu4.json` and `-motionoff.json`). `inspect20.mjs` shows that each step's long task (65–180 ms at 4×) is the click handler: React rendering the checklist, the picker list or the created view. It runs before the motion starts, and the motion-off run has the same tasks. During the motion, frames land every 16–29 ms at 4× and every 9–16 ms unthrottled. The height steps cost 0.3–0.8 ms of layout per frame unthrottled and ≤ 5 ms at 4×. Motion added no long task. (The frame reporter's presented and dropped counts read 0 in this Chrome build, as in ticket 19's script; the gaps come from `DrawFrame`.)

### `review-animations` on the diff

| Before | After | Why |
|---|---|---|
| `Switch` track `transition-colors duration-hover` (Tailwind's default curve) | `+ ease-[ease]` | Colour changes use `ease` (standards; the motion system's hover recipe) |
| Audit Entries details `transition-opacity duration-fade` (fade only) | `riseIn` (shift-sm + fade, `list-in`, `ease-out`) | A fade with no transform is an escalation trigger; the system's row recipe is shift-sm + fade. Still a plain fade under reduced motion |

Answered, not changed: the created view's three parts enter on one frame rather than staggered. They are one entrance (the dialog's new content, split only by the Dialog's title, description and body slots), and a stagger would hold back the key the Owner is there to copy. The dialog's own height changes at once between the form and the created view. Animating a centred dialog's height would mean moving the whole dialog. The content fading in bridges it. The collapse uses the same 200 ms each way, as the system's `collapse` token sets; it isn't a press-and-release. Height is the documented exception, measured by UI SDK. Verdict after the fixes: approve.

### Notes

- `ui/Switch.tsx` was listed for "17 or 20, whichever runs first". This ticket did it, so 17 can skip it.
- The throwaway seed server (`zz_uiseed_test.go.txt` plus discovered models) exited without a message several times after a few minutes. It looks unrelated to the UI; I restarted it between runs.
