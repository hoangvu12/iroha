# 01: UI SDK foundation, pointer cursor, page widths

**What to build:** Install `@ui-sdk/react` and `@ui-sdk/core` pinned to the same exact version (`0.1.0-beta.12`, no `^`). Declare `@layer ui-sdk;` at the top of `web/src/styles/index.css`, above `@import "tailwindcss"`; don't import `web.css`. Add the note UI SDK's quick start asks for to `AGENTS.md` (read `node_modules/@ui-sdk/react/docs/llms.txt` first; `core.md` by heading with `rendering.md` only to build a missing part; the skill at `vercel-labs/ui@8b452a3aa1` `packages/core/skills/ui-sdk/` is read, not installed). Rebuild `web/src/ui/Button.tsx` and `Input.tsx` on UI SDK Button, Input and Field, keeping their current look and props so pages keep working. Restore the pointer cursor Tailwind 4 removed (buttons, `[role=button]`, links, menu items, tabs, clickable rows; `not-allowed` or default when disabled) in the base layer. Add one page-width system (a `PageBody` or equivalent with a readable width of about 768px for forms and settings and a wide width of about 1280px for tables and the route view) and apply it to every page, including Provider, Pool and Gateway Key settings tabs, Settings, Login and Setup.

**Blocked by:** none

**Status:** done

Spec stories: 1, 4, 16. Spec: `.scratch/v2-ui/spec.md`.

- [x] Both packages pinned to one exact version; `npm run build` and typecheck clean
- [x] Pointer cursor on every interactive element, checked in the browser on each page
- [x] No page stretches across a 2560px window; forms read in a column
- [x] Button and Input are UI SDK-based with the same look in light and dark

## Comments

**Built**
- `@ui-sdk/react` + `@ui-sdk/core` `0.1.0-beta.12` (exact). `@layer ui-sdk;` first in `styles/index.css`, no `web.css`. `AGENTS.md` has the quick-start note; the skill is read from `web/node_modules/@ui-sdk/core/skills/ui-sdk/` (it ships in the package, same as `vercel-labs/ui@8b452a3aa1`).
- `ui/Button.tsx`: `Button` and `IconButton` are UI SDK's Button with the same variants, sizes, props and `buttonClass`. `loading` disables and sets `aria-busy`; an `onClick` returning a Promise makes it pending (`data-pending`) by itself.
- `ui/Input.tsx`: `Input` and `SearchInput` on UI SDK Input, `PasswordInput` on UI SDK Password Input (toggle "Show password" with `aria-pressed`), `Field` on UI SDK Field/FieldLabel/FieldDescription/FieldError (error has `role="alert"`). `Field` keeps its `children(props)` API so every page works unchanged; native selects and textareas inside it are still labelled and described (via `useFieldControl`). `value`/`defaultValue` are typed `string` now (UI SDK's type); nothing in the app passed anything else.
- Pointer cursor: base-layer rule in `styles/index.css`, `not-allowed` while disabled. Removed `cursor-default` from the Radix menu items (`ui/Menu.tsx`, `pages/requests/menus.tsx`).
- Page widths: `app/PageBody.tsx` (`wide` 1280 px centred, `readable` 768 px). Shell wraps every page except Chat in `wide`; `readable` on Provider and Pool Settings, the Gateway Key page, Settings → Sign-in and the Login/Setup form column (replacing the ad-hoc `max-w-[760px]`s). The Route view overlay got its own `wide` frame. Chat keeps its own full-height layout (its messages and composer are already a ~760 px column).
- Web tests: Vitest 5.1.0 + jsdom 31.0.1 + Testing Library (react 16.3.3, dom 10.4.2, user-event 14.6.13), all exact; `npm --prefix web test`. Setup per the skill's `references/testing.md`. How later tickets write tests is in `docs/agents/architecture.md` "UI ticket 01".

**Test-first**: `ui/Button.test.tsx` and `ui/Input.test.tsx` were written first and failed on the old components (8 of 14 red: no `data-slot`, agent snapshot empty), then passed after the rebuild. `pages/login/LoginPage.test.tsx` adds the agent test on real page markup (Login: an agent fills Password and presses Sign in; wrong password announced and described; Setup refuses empty fields, then PUTs with the Admin Token). Every interface has the agent test. Break-on-purpose: 6 of 6 deliberate breaks (Field wiring, loading, error role, repeated describedby, toggle name, default type) made a test fail.

**Browser checks** (headless Chrome, seeded testkit): all 22 page states (21 pages plus an open menu) × light, dark, phone 390 px and 2560 px, each audited for pointer cursor on every visible control, page-frame widths and sideways scroll: 0 issues. Screenshots and `audit.json`: `C:\Users\ADMIN\Desktop\nguyenvu\iroha-v2-notes\v2-ui\shots\01\`. Script `check-pages.mjs` and seed `zz_uiseed_test.go.txt` are in `iroha-v2-notes\v2-ui\` for later tickets.

**Notes for later tickets**
- Agent labels collide by word (checked): on Setup, `act` with ref "Password" fails with "names 3 components: Password, Confirm password, Set password and sign in". Settings → Sign-in's "Current/New password" will be the same. An agent needs the `cN` ref from `snapshot()` there; a ticket touching those pages could give the labels distinct words.
- Login's art still fills 53% of a 2560 px window (it's a picture, not text); the form is the readable column.
