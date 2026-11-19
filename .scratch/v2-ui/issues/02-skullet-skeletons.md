# 02: Measured skeletons with Skullet

**What to build:** Install `skullet` pinned to `0.0.3` and read its README in full (`node_modules/skullet/README.md`): `Skeleton` with `data` and `sample`, `loading` for refetches, `id` for remembered shapes, `label` for screen readers, `SkulletProvider` (theme, `mode` following Iroha's theme, `reveal="smart"`), hints (`skullet-block`, `skullet-ignore`, static `.Skeleton`), `forgetShapes()`, and the dev warnings and `?skullet-debug` overlay. Mount one `SkulletProvider` at the root with a theme from Iroha's tokens for light and dark (base and highlight that read as Iroha's surfaces, radius matching the UI). Replace every hand-made loading state and skeleton in `web/src` with Skullet: give each data-driven view a `sample` (paste the one the dev warning logs, then trim), an `id` where a reload should be exact, and a `label`. Call `forgetShapes()` on sign-out. Leave the DataTable's skeleton to ticket 06, but make the pattern it should follow obvious (a short note in `docs/agents/architecture.md`).

**Blocked by:** 01

**Status:** done

Spec story: 8.

- [x] No remaining hand-made skeleton or "Loading..." placeholder for page data
- [x] `?skullet-debug` shows no content shift on Providers list, a Provider page, a Request drawer and Gateway Keys
- [x] A refetch over shown data never flashes a skeleton; a load under 150ms shows none
- [x] Sign-out forgets remembered shapes; skeletons hold still under reduced motion

## Comments

**Built.** `skullet@0.0.3` (exact pin). One `SkulletProvider` (`web/src/app/skeletons.tsx`) inside `ThemeProvider`: `mode` follows the Owner's theme, base `--bg-muted`, highlight the new `--skeleton-highlight` token (light and dark), radius 6 px, slow shimmer, `reveal="smart"`. Pages use `@/ui/Skeleton`, a thin wrapper that requires `sample` and `label`, takes an `ErrorState` as `error`, gives samples `useIsSample()` (so `LogoTile` requests no logo for sample rows) and renders the sample inside a component boundary (Skullet's walk over the sample's elements re-sets each element's children as an array, which crashed every inline `asChild` row menu: Endpoints, Models, Pool Members). `TableSkeleton` and the old `.skeleton` shimmer are gone; every page's loading state (Providers list and Pools, Keys, Endpoints, Models, Rules, Provider and Pool settings, Pool Route and Members, Gateway Keys list and page, model picker, scope editor, Requests stats, feed, Callers menu, drawer, Attempts, Captured, Route view, Admin Tokens, Audit Entries, Sign-in sessions, Chat's Details and key list, the `/states` Loading panel) is a `Skeleton` with a sample in `pages/<page>/samples.ts`, a stable `id` (with `:phone` where the phone layout differs) and a label. Skeletons wait for every query their content needs, so numbers don't fill in after the reveal. Requests feed and Audit Entries keep the previous rows (dimmed) when filters change (`keepPreviousData`); the live poll pauses while the rows are placeholders. `forgetShapes()` on sign-out and when the session ends by itself. The architecture note ("UI ticket 02") describes the pattern, including the one ticket 06's DataTable should follow.

**Test-first.** Red then green for each: provider theme follows the Owner's choice, not the OS (`app/skeletons.test.tsx`); sign-out clears `skullet:shapes` (`api/session.test.tsx`); the label is read while loading and the sample is hidden, sample logos request no image, an agent sees no sample controls and presses the real ones after data, a sample with an inline `asChild` menu renders (`ui/Skeleton.test.tsx`); a filter change keeps the shown rows with no skeleton, a first load shows the label (`pages/requests/Feed.test.tsx`).

**Browser checks** (headless Chrome, seeded server, every `/api/` answer held 2.5 s; light, dark, phone 390 px). Screenshots and `report.json` in `iroha-v2-notes/v2-ui/shots/02/` (`<page>-<variant>-loading.png` first visit, `-reload-loading.png`, `-debug.png` with `?skullet-debug`), script `skel-check.mjs` there.
- `?skullet-debug` on reload (shape remembered under the id): no movement on the Providers list (desktop; phone Pools table 2 px), Provider Keys, Endpoints, Models and Settings tabs, Pool Route and Members, Gateway Keys list and page, Requests stats, Admin Tokens, Sign-in; the Request drawer body moves 2 px. First visits are drawn from the sample, so a list moves by however many rows it has more or fewer than the sample.
- Filter change on Requests with slow answers: rows stay, dimmed, no skeleton. Fast in-app navigation shows no skeleton (the few mutations counted were the 150 ms hold, never painted). Reduced motion: no running animations on skeletons. Sign-out leaves `skullet:shapes` holding only the Sign-in tab's sessions shape, which Skullet re-saves as the tab unmounts after `forgetShapes()`; nothing of the earlier pages remains.

**Notes and deferred.**
- Skullet keeps shapes over ~20 KB in memory only, so after a full reload big desktop lists (Requests feed, Failure Rules, Audit Entries) are drawn from the sample again. The Rules sample is the 18 built-in rules and the Audit sample is longer than a screen, so those come close.
- Skullet's `skullet-own` attribute (keeps an element painted) makes it ignore remembered shapes, so headers and labels inside a skeleton are drawn as bars. Don't use it.
- Left alone: the blank `aria-busy` frame while `AuthGate` checks the session and Chat's one-frame blank before its local state is set (not page data); `animate-pulse` in `chat/Reply.tsx` and `requests/bits.tsx` (live indicators, for the motion tickets); the Keys dialog's "Checking…" dry-run status text (a status line, not page data).
- `PageHeader`'s description is a `div` now, so it can hold a skeleton.
- The Route view on a phone moves 44 px on reveal even from its remembered shape (the canvas fills the column after its data lands); not one of the four checked views.
