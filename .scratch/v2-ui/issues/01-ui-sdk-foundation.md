# 01: UI SDK foundation, pointer cursor, page widths

**What to build:** Install `@ui-sdk/react` and `@ui-sdk/core` pinned to the same exact version (`0.1.0-beta.12`, no `^`). Declare `@layer ui-sdk;` at the top of `web/src/styles/index.css`, above `@import "tailwindcss"`; don't import `web.css`. Add the note UI SDK's quick start asks for to `AGENTS.md` (read `node_modules/@ui-sdk/react/docs/llms.txt` first; `core.md` by heading with `rendering.md` only to build a missing part; the skill at `vercel-labs/ui@8b452a3aa1` `packages/core/skills/ui-sdk/` is read, not installed). Rebuild `web/src/ui/Button.tsx` and `Input.tsx` on UI SDK Button, Input and Field, keeping their current look and props so pages keep working. Restore the pointer cursor Tailwind 4 removed (buttons, `[role=button]`, links, menu items, tabs, clickable rows; `not-allowed` or default when disabled) in the base layer. Add one page-width system (a `PageBody` or equivalent with a readable width of about 768px for forms and settings and a wide width of about 1280px for tables and the route view) and apply it to every page, including Provider, Pool and Gateway Key settings tabs, Settings, Login and Setup.

**Blocked by:** none

**Status:** open

Spec stories: 1, 4, 16. Spec: `.scratch/v2-ui/spec.md`.

- [ ] Both packages pinned to one exact version; `npm run build` and typecheck clean
- [ ] Pointer cursor on every interactive element, checked in the browser on each page
- [ ] No page stretches across a 2560px window; forms read in a column
- [ ] Button and Input are UI SDK-based with the same look in light and dark
