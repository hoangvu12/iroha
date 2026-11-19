# 02: Measured skeletons with Skullet

**What to build:** Install `skullet` pinned to `0.0.3` and read its README in full (`node_modules/skullet/README.md`): `Skeleton` with `data` and `sample`, `loading` for refetches, `id` for remembered shapes, `label` for screen readers, `SkulletProvider` (theme, `mode` following Iroha's theme, `reveal="smart"`), hints (`skullet-block`, `skullet-ignore`, static `.Skeleton`), `forgetShapes()`, and the dev warnings and `?skullet-debug` overlay. Mount one `SkulletProvider` at the root with a theme from Iroha's tokens for light and dark (base and highlight that read as Iroha's surfaces, radius matching the UI). Replace every hand-made loading state and skeleton in `web/src` with Skullet: give each data-driven view a `sample` (paste the one the dev warning logs, then trim), an `id` where a reload should be exact, and a `label`. Call `forgetShapes()` on sign-out. Leave the DataTable's skeleton to ticket 06, but make the pattern it should follow obvious (a short note in `docs/agents/architecture.md`).

**Blocked by:** 01

**Status:** open

Spec story: 8.

- [ ] No remaining hand-made skeleton or "Loading..." placeholder for page data
- [ ] `?skullet-debug` shows no content shift on Providers list, a Provider page, a Request drawer and Gateway Keys
- [ ] A refetch over shown data never flashes a skeleton; a load under 150ms shows none
- [ ] Sign-out forgets remembered shapes; skeletons hold still under reduced motion
