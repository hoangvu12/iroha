Status: ready-for-agent

# Configurable Provider Logos

## Problem

Provider imagery is currently determined only by the Provider Template. Branded templates render their fixed brand through browser-side logo.dev or Google favicon requests, while the generic template always renders a Server icon even when its Provider base URL identifies a recognizable service. The UI also bypasses an existing backend logo proxy/cache, exposing the logo.dev request and token to the browser.

The Owner needs every Provider to have an editable visual identity without adding image uploads or an asset-management system.

## Goals

- Give every Provider a nullable Logo Domain.
- Seed branded Providers with the template's official hostname.
- Seed generic Providers from the hostname of their base URL.
- Let the Owner change or clear the Logo Domain during create and edit flows.
- Resolve and cache Provider Logos through Iroha's backend.
- Preserve existing branded Provider imagery during migration.

## Non-goals

- Local image upload or filesystem selection.
- Arbitrary image URLs.
- Fetching a favicon from the Provider website.
- Falling back from a subdomain to its registrable domain.
- Adding a browser, JS-DOM, or Playwright test harness.

## Domain model

A Provider stores `logoDomain: string | null`:

- A normalized hostname selects remote logo discovery.
- `null` disables discovery and selects the generic Server icon.
- No separate automatic/custom/disabled mode is persisted.

The create API distinguishes an omitted property from explicit `null`. Omission derives the initial value from the selected branded template or, for a generic template, the submitted base URL. Explicit `null` disables the logo.

The update API treats omission as no change, a hostname as replacement, and explicit `null` as disablement. When a generic Provider's base URL changes and its saved Logo Domain equals the old base URL hostname, the Logo Domain follows the new hostname. A different custom hostname or null is preserved.

Duplicating a Provider copies `logoDomain`, including null. Archiving retains it; purging removes it with the Provider.

## Input and normalization

The Logo domain field accepts either a hostname or an HTTP(S) URL for convenience. Iroha persists only the normalized hostname: lowercase, without a trailing dot, scheme, credentials, port, path, query, or fragment. Empty input maps to null. Non-empty input that cannot produce a valid hostname prevents saving and produces an inline validation error.

Selecting a branded template fills its official hostname while the field is untouched. Selecting the generic template and entering a valid base URL fills its hostname after a debounce. Later valid base URL changes continue to synchronize only while the Logo domain field remains untouched. Template selection does not overwrite an Owner-edited or cleared field.

## UI

Add Logo domain immediately after Base URL in both Add Provider and Edit Provider.

- Show the resolved preview beside the field.
- Debounce validation, derivation, and preview requests.
- Retain the previous preview while a new request is pending.
- Show the generic Server icon for empty, invalid, or unresolved input without an error notification.
- When populated, show an X absolutely positioned over the input's far-right edge; reserve input padding for it so it consumes no adjacent layout space. Its accessible name is `Clear Logo domain`.
- Clearing marks the field as touched, immediately shows the generic icon, and prevents later base URL edits from repopulating it during that form session.
- Preserve theme-aware logo.dev previews.

Provider list and detail surfaces render from each Provider's `logoDomain`, not directly from its template identity.

## Backend resolution

Add an Owner-authenticated endpoint:

`GET /api/v1/admin/brand-logos/resolve?domain={hostname}&theme={light|dark}`

It returns cached image bytes for the exact normalized hostname. Resolution order is:

1. logo.dev, when configured
2. Google favicon
3. not found, which the UI renders as the generic Server icon

If no logo.dev token is configured, resolution starts with Google favicon. Iroha never contacts the Provider hostname for logo discovery. There is no parent-domain retry.

Keep `/api/v1/brand-logos/:templateId` temporarily and route both endpoints through the same service. Move active UI usage to the authenticated domain resolver. Cache by normalized hostname and theme rather than template ID, and cache misses briefly to prevent repeated external calls. Preserve the existing browser cache behavior.

This boundary is governed by `docs/adr/0018-provider-logos-resolve-through-the-backend.md`.

## Persistence and migration

Add nullable `logo_domain` columns to both SQLite and PostgreSQL Provider schemas and repository mappings.

Backfill existing Providers as follows:

- branded template: the template's official brand hostname
- generic template: hostname derived from the existing base URL
- no valid derivation: null

Current branded Providers therefore retain the logo.dev identities they display today.

## Privacy

The configured Logo Domain is disclosed by Iroha's backend to logo.dev and, on fallback, Google favicon. It is no longer disclosed directly by the Owner's browser, and the logo.dev token is not exposed in browser-visible requests. Clearing Logo domain is the per-Provider opt-out.

## Verification

Focused repository, service, and HTTP tests cover:

- hostname/URL normalization and invalid input
- create omission versus explicit null
- update omission, replacement, disablement, and generic base URL synchronization
- SQLite and PostgreSQL migration/backfill behavior
- duplication and archive behavior
- exact-host logo.dev then Google fallback order
- operation without a logo.dev token
- hostname/theme cache identity and negative caching
- authentication and invalid resolver queries
- legacy template endpoint behavior

No browser or JS-DOM tests and no required manual browser pass are part of acceptance, consistent with `docs/agents/ui-testing.md`.

## Open questions

None.
