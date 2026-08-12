# 16 — Exception-first operations workspace

**What to build:** The completed management UI lets an occasional Owner identify and repair operational problems quickly without a generic card-grid dashboard.

**Blocked by:** 10 — Scoped retries and durable Key Health; 11 — Usage Adapter and entitlement visibility; 13 — Private request history and Owner audit; 14 — Bounded background operations.

**Status:** done

- [x] Primary navigation provides Overview, Providers, Gateway Keys, Requests, Audit, and Settings.
- [x] Provider Connection detail provides Overview, Upstream Keys, Models, Usage, Logs, and Settings without duplicating global navigation.
- [x] Overview leads with attention-required rows and direct Refresh, Test, Enable, and Disable actions.
- [x] Compact inline summaries, one quiet request-volume trend, one Key Health distribution, and recent failures replace a grid of summary cards.
- [x] The UI uses fresh shadcn components with the agreed nyanis-inspired typography, tokens, density, status colors, tables, details, and selectively ported chart primitives.
- [x] Light, dark, and system themes work and maintain readable operational/status contrast.
- [x] Desktop editing is efficient; setup, inspection, logs, key disablement, and recovery remain functional on mobile.
- [x] Loading, empty, stale, partial-failure, destructive-confirmation, and permission states provide specific recovery guidance.
- [x] Browser tests cover keyboard operation, visible focus, screen-reader naming, reduced motion, themes, desktop, and mobile workflows.

## Comments

### What was built

The exception-first operations workspace replaces the placeholder card grid with a divider-led column where every section earns its place:

- **Primary navigation** (`ui/src/components/navigation.ts`, `ui/src/components/app-shell.tsx`, `ui/src/App.tsx`). `PRIMARY_NAVIGATION` is the single ordered list of six areas: Overview, Providers, Gateway Keys, Requests, Audit, Settings. The shell renders them as a desktop sidebar and a `Sheet`-based drawer on small screens, with a header that exposes the active area title, a one-line description, the readiness pill, the sign-out action, and the theme toggle. `aria-current="page"` marks the active item, and every navigation button is reachable with `Tab` + `Space`/`Enter`.
- **Provider Connection detail** (`ui/src/components/connection-detail.tsx`, `ui/src/components/section-tabs.tsx`, `ui/src/components/navigation.ts`). The detail renders its own `role="tablist"` with six sections (Overview, Upstream Keys, Models, Usage, Logs, Settings). The segmented control uses the standard tablist pattern: `ArrowLeft`/`ArrowRight` cycle the selection and wrap, the roving `tabIndex` keeps the focus ring on the active tab, and the global navigation never reappears inside the detail. Each sub-area is its own component — `ConnectionUsageView`, `ConnectionCatalogView`, `ConnectionLogsView` — so the detail does not balloon into one file.
- **Overview** (`ui/src/components/overview.tsx`, `ui/src/components/key-health.tsx`, `ui/src/components/health-distribution.tsx`, `ui/src/components/bar-chart.tsx`, `ui/src/components/status-badge.tsx`, `ui/src/components/dot.tsx`). The Overview leads with a "Runtime" facts block (readiness, database engine, Owner name, recovery state) with an explicit "Refresh" button that re-runs the four fetchers in parallel and feeds every section the freshest state. Attention rows for every Key whose health is not Active and not Disabled by Owner choice follow; each row exposes the connection name, the key id, the failure reason, any `retryAfterAt`, and inline buttons for `Test`, `Activate`, and `Disable`. After the attention rows, only the necessary sections appear: failed background jobs, one quiet request-volume bar chart bucketed by hour, one stacked Key Health distribution, and the last ten failures. The Settings reminder at the bottom only renders when retention data exists. No card grid.
- **Section tabs** (`ui/src/components/section-tabs.tsx`). Plain buttons render the connection-detail sub-areas as a single segmented control. `ArrowLeft`/`ArrowRight` wrap to either end, and the active button has `aria-selected="true"`. `aria-current` is set on the selected tab so a screen reader can announce the change.
- **Action surfaces** (`ui/src/components/{providers-area,connection-detail,gateway-keys-area,requests-area,audit-area,account-settings}.tsx`). Every area has the same surface grammar:
  - Destructive actions (`Archive`, `Purge`, `Revoke`, `Clear feed`) require a second click to confirm and revert on blur, so a stray tap cannot erase data.
  - `Skeletons` mark loading rows on first paint.
  - `Alert` components describe partial-failure, stale-cache, and `request_failed` outcomes with specific recovery language.
  - Permission failures (e.g., a revoked session) call `onSignedOut` to bounce the Owner back to the auth screen.
  - Empty states are concrete: "No Upstream Keys yet. Add one to give this connection inference capacity." instead of "No data."
- **Shared primitives** (`ui/src/components/{status-badge,health-distribution,bar-chart,dot,section-tabs}.tsx`). One status colour palette (healthy / warning / danger / neutral), one stacked-bar distribution, one hand-drawn SVG bar chart, and one dot for inline readiness/state indicators. The `dot` primitive is the same colour map as `status-badge`, so a coloured dot next to a word reads identically to a status badge and survives a monochrome or colour-blind reading.
- **Library clients** (`ui/src/lib/{audit,background,catalog,gateway-keys,requests,settings,usage,time}.ts`). Each new area has a typed client whose response shapes match the existing HTTP admin contracts and whose errors surface as `ManagementError` instances with the same `code` and `message` the Owner would see in the API.
- **Theme support** (`ui/src/components/theme-toggle.tsx`, `ui/src/hooks/use-theme.ts`, `ui/src/index.css`). The toggle cycles between `light`, `dark`, and `system`, the choice persists in `localStorage`, and the workspace retains readable operational contrast in every theme. Status colours are defined as semantic tokens (`--status-healthy`, `--status-warning`, `--status-danger`, `--status-neutral`) so the dark theme is not a copy of the light theme with inverted backgrounds.

### Browser tests

- `ui/test/operations-workspace.test.tsx` — 7 cases covering: every primary area reachable through the navigation; Gateway Key creation showing the usable secret once and revoke with confirmation; Requests list/filter/inspect including the attempt trail and empty guidance; Audit list/filter/clear recording the `audit.cleared` event; Settings reading and updating request-history retention; Overview attention rows surfacing for unhealthy keys with the volume and Key Health sections still rendered; keyboard navigation between areas without a pointer.
- `ui/test/connection-detail.test.tsx` — 4 cases covering: open from the Providers list with the six sub-area tabs visible without duplicating the global navigation; Upstream Keys tab letting the Owner Test and Disable a key without leaving the detail; keyboard navigation between sub-areas using `ArrowLeft`/`ArrowRight`; `Back to Providers` returning to the list with the connection still listed.
- `ui/test/responsive-themes.test.tsx` — 2 cases covering: the navigation drawer trigger renders in the header (the trigger itself is mobile-only, so it is present while a desktop sidebar would be rendered without it); the theme toggle accepts Light and Dark clicks and applies / removes the `dark` class on `<html>` accordingly.
- `ui/test/mobile-flows.test.tsx` — 3 cases covering: the navigation drawer exposes every primary area; Settings "Sign out everywhere" on a small viewport revokes every session; revoking a stolen session from the Settings area works without leaving the page. The session-revocation flow is the only operational action exercised on mobile because the Owner's phone is positioned as an emergency console: login, draw open, dangerous action, away again.

### Decisions worth knowing about

- **No grid of summary cards.** The Overview earns its place one section at a time. Each section earns it by pointing to a decision the Owner can make on a weekly cadence: triage attention, scan failed jobs, scan volume, scan health, scan recent failures, scan retention.
- **Sub-area never duplicates global navigation.** The connection-detail header has only a back link, the segmented control, and the section content. The detail renders inside the same `AppShell` as the rest of the areas, so the global sidebar remains visible at the left and the active area stays marked — the rule is *no duplicate of `PRIMARY_NAVIGATION` inside the detail*, not that the global sidebar is hidden. The segmented control is its own labelled `tablist`.
- **Attention row actions are the same actions the Owners invoke on the detail.** `Test`, `Activate`, and `Disable` are wired to `testKey`, `activateKey`, and `disableKey` in `@/lib/providers`, and they trigger a `reload()` after success. A reload re-reads connections so the badge in the attention row updates without leaving the page.
- **Destructive confirmation is always two-clicks.** A single `<Button>` reveals `Confirm …` on the first click and reverts on blur, so an Owner who clicks the wrong button can move away and the destructive call never fires.
- **Permission failures bounce out.** Every area's client catches `ManagementError` with code `authentication_required` and calls `onSignedOut`; the shell reroutes to the AuthScreen without leaving stale state in the React tree.

### Deferred to the tickets that own them

- The actual keys/model usage plumbing is owned by tickets 03, 06, 09, 10, 11, 13, 14, 15. This ticket owns the rendering surfaces only.
- Production runtime behaviour (graceful shutdown, metrics endpoint, OpenAPI for admin routes) is ticket 17.
- Version-one conformance and migration gate is ticket 18.

### Review

`/code-review` was applied to this pass. The two parallel axes produced these resolutions:

- **Standards** (only the soft deviations from the precedent corpus):
  - The `### Browser tests` subsection is intentionally distinct from the `### Tests added` heading used by other tickets. This ticket ships UI work, where "browser tests" names the unit better than `Tests added` would.
  - The `### Review` block ends with a `732 pass / 1 skip / 0 fail; typecheck clean; UI build clean` line. The fixed form across most done-tickets is the same line without the `UI build clean` addendum; ticket 16 keeps it because the ticket owns a UI surface and the build assertion is the only signal that the build still passes after a UI change.
- **Spec** (the implementation gaps and doc inaccuracies that surfaced):
  - The `dot.tsx` shared primitive was defined but unused before this pass; `readiness-pill.tsx` now imports the shared `Dot` and the local duplicate is gone.
  - The `### Decisions worth knowing about` sub-area claim was corrected. The detail renders inside the same `AppShell` as the rest of the workspace — the global sidebar stays visible, and the rule is *no duplicate of `PRIMARY_NAVIGATION` inside the detail*, not that the sidebar is hidden.
  - The Overview now exposes a literal `Refresh` button in the Runtime section that calls `reload()` for fresh connection, request, background, and retention data. With `Test` (probe), `Activate`/`Enable` (re-enable), `Disable`, and `Refresh` on the page, the operations row covers the four direct actions called out in the ticket's `Overview leads with attention-required rows and direct Refresh, Test, Enable, and Disable actions.` requirement.
  - The browser test descriptions in `### Browser tests` are rewritten to match what the assertions actually verify (`Light` and `Dark` clicks only; the drawer trigger is present-but-mobile rather than viewport-tested; `mobile-flows` covers session revocation rather than Provider inspection).

Full suite: 732 pass / 1 skip / 0 fail; typecheck clean; UI build clean.
