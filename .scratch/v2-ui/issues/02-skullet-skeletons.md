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

**Built.** `skullet@0.0.3` (exact pin). One `SkulletProvider` (`web/src/app/skeletons.tsx`) inside `ThemeProvider`: `mode` follows the Owner's theme, base `--bg-muted`, highlight a new `--skeleton-highlight` token (light and dark), radius 6 px, slow shimmer, `reveal="smart"`. Pages use `@/ui/Skeleton`, a thin wrapper that:
- requires `sample` and `label` and takes an `ErrorState` as `error`;
- gives samples `useIsSample()`, so `LogoTile` requests no logo for sample rows;
- renders the sample inside a component boundary. Skullet's walk over the sample's elements turns a single child into an array, which crashed every page with an inline single-element trigger (row menus, then `Tip` after the move to UI SDK);
- holds a skeleton unseen for its first 150 ms (`skeleton-hold` in `styles/index.css`). Skullet's React `Skeleton` paints one from the first frame when it mounts loading, so without this a 90 ms load flashed a skeleton.

`TableSkeleton` and the old `.skeleton` shimmer are gone. Every page's loading state is now a `Skeleton` with a sample in `pages/<page>/samples.ts`, a stable `id` (`:phone` where the phone layout differs) and a label. That covers:
- Providers list and Pools, the Keys, Endpoints, Models, Rules and Settings tabs, Pool Route, Members and Settings;
- Gateway Keys list and page, the model picker, the scope editor;
- Requests stats and feed, drawer, Attempts, Captured, the Route view;
- Admin Tokens, Audit Entries, Sign-in sessions;
- Chat's Details, the `/states` Loading panel.

The chat Picker's key, Endpoint and Send-as lists and the Requests Callers menu load as skeleton rows placed under their lists. Rows inside the list would join its keyboard navigation. Skeletons wait for every query their content needs, so numbers don't fill in after the reveal. The Requests feed and Audit Entries keep the previous rows, dimmed, when filters change (`keepPreviousData`), and the live poll pauses while those rows are placeholders. Sign-out forgets the remembered shapes in `useSignOut`, and also in `AuthGate` once the signed-out screen has replaced the pages. Skullet saves a skeleton's shape as it unmounts, so forgetting before that left shapes behind. The architecture note ("UI ticket 02") describes the pattern, including the one ticket 06's DataTable should follow.

**Test-first.** Each of these went red then green:
- the provider follows the Owner's theme, not the OS (`app/skeletons.test.tsx`);
- sign-out clears `skullet:shapes` (`api/session.test.tsx`);
- while loading, the label is read and the sample is hidden; sample logos request no image (`ui/Skeleton.test.tsx`);
- an agent sees no sample controls while loading and presses the real ones after the data arrives (`ui/Skeleton.test.tsx`);
- a sample with an inline `Tip` renders. Checked red again after the merge by removing the boundary (`ui/Skeleton.test.tsx`);
- a filter change keeps the rows on screen with no skeleton, and a first load shows the label (`pages/requests/Feed.test.tsx`).

Two fixes could not be tested in jsdom, because it has no layout and Skullet saves no shapes there: the 150 ms hold and the sign-out timing. The browser checks below cover them.

**Browser checks** ran in headless Chrome against the seeded server, on the merged build, with every `/api/` answer held 2.5 s, in light, dark and phone (390 px). Screenshots and `report.json` are in `iroha-v2-notes/v2-ui/shots/02/`: `<page>-<variant>-loading.png` is the first visit, `-reload-loading.png` the reload, `-debug.png` the page with `?skullet-debug`. The scripts are there too: `skel-check.mjs`, `fast.mjs`, `signout.mjs`.
- **Reload** (shape remembered under the id), `?skullet-debug`:
  - Providers list: no movement on desktop; the phone Pools table moves 2 px.
  - Provider page: no movement on the Endpoints, Models, Rules and Settings tabs, and on the Keys tab on phone. The desktop Keys tab moves 288 px: its shape is over Skullet's 20 KB storage limit, so a reload uses the 10-row sample and the seed Provider has 4 keys. Real Providers average about 25 keys, more than the sample.
  - Request drawer: the body moves 3 px.
  - Gateway Keys list and page: no movement.
  - Also no movement: Pool Route and Members, Requests stats, Admin Tokens, Sign-in.
- **First visit**: drawn from the sample, so a list moves by however many rows it has more or fewer than the sample. The Rules sample is the 18 built-in rules and shows no movement.
- **Refetch and fast loads**: a filter change on Requests with slow answers keeps 9 rows, dimmed, with no skeleton. In-app navigation with instant answers (loads of 31, 76 and 319 ms) painted no skeleton bar before 140 ms.
- **Reduced motion**: two screenshots 400 ms apart differ with motion allowed (shimmer) and match under reduce.
- **Sign-out**: `skullet:shapes` held `gateway-keys, admin-tokens, providers-list, pools-list` before signing out and is empty after.

**Notes and deferred.**
- Skullet keeps shapes over about 20 KB in memory only. After a full reload, big desktop lists (Requests feed, Keys, Rules, Audit Entries) are drawn from the sample again. In-app visits keep them exact.
- Skullet's `skullet-own` attribute (keeps an element painted) also makes it ignore remembered shapes. So table headers and labels inside a skeleton are drawn as bars; don't use the attribute.
- Left alone:
  - the blank `aria-busy` frame while `AuthGate` checks the session, and Chat's one-frame blank before its local state is set (neither is page data);
  - `animate-pulse` in `chat/Reply.tsx` and `requests/bits.tsx` (live indicators, for the motion tickets);
  - the model search's own status in the chat Picker (results for an older search stay until new ones land);
  - the Keys dialog's "Checking…" dry-run status line.
- `PageHeader`'s description is a `div` now, so it can hold a skeleton.
- On a phone, the Route view moves 44 px on reveal even from its remembered shape. It is not one of the four views the ticket names.

