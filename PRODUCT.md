# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Iroha serves one self-hosting Owner who configures provider connections and access for their own applications. The Owner returns occasionally to investigate failures, inspect request metadata, or change configuration rather than monitoring the product continuously.

## Product Purpose

Iroha gives the Owner one self-hosted gateway for multiple OpenAI-compatible inference providers. Success means the Owner can configure connections and keys through the UI, use exact upstream model names through provider-scoped OpenAI endpoints, survive unhealthy upstream keys, discover permitted providers and models, and diagnose routing failures without reading server logs.

## Positioning

Iroha separates explicit Provider Connection selection from automatic Upstream Key health and rotation: the caller chooses the connection in the base URL, while Iroha selects an eligible key, classifies failures, and recovers capacity without renaming the upstream model.

## Operating Context

Iroha is deployed as a single self-hosted instance. It exposes a normal Bun build/start contract and serves HTTP without prescribing Docker, Nixpacks, or another packaging system. The hosting environment may provide public TLS. The Owner manages Iroha in a browser. Applications authenticate with scoped Gateway Keys and call provider-scoped Chat Completions or Responses endpoints using OpenAI-compatible clients.

## Capabilities and Constraints

- Provider Connections, Upstream Keys, exact Upstream Models, Gateway Keys, and settings are managed through a database-backed UI and API.
- Version one supports OpenAI Chat Completions and Responses, including streaming, tools, structured output, cancellation, and OpenAI-shaped errors.
- Provider and model discovery is authenticated and filtered by Gateway Key scope.
- Multiple eligible Upstream Keys are selected round-robin; retry decisions account for failure scope, persistent Key Health, attempt limits, cooldown, and streaming boundaries.
- Known Usage Adapters may read provider-specific balance or plan usage. Generic connections report authoritative balance as unknown.
- Only metadata is retained for inference requests; prompts, responses, and secret values are not stored.
- One Owner account is created through first-run setup. There is no tenant or public-registration model.
- SQLite and PostgreSQL are supported through Drizzle with dialect-specific migrations selected from `DATABASE_URL`.
- `DATABASE_URL` and `IROHA_MASTER_KEY` are explicit startup requirements. `IROHA_SETUP_TOKEN` is required until the Owner exists; recovery token, host, and port are optional.
- Bun is the production runtime; Elysia serves the inference API, management API, generated OpenAPI documentation, and built React application.
- The management UI uses React, Vite, TypeScript, and shadcn/ui.
- Dockerfiles, Nixpacks configuration, and real-provider test harnesses are not version-one requirements.
- Iroha is independent of nyanis. Provider-specific knowledge may be implemented separately without sharing nyanis credentials or database state.

## Brand Commitments

The management UI starts from a fresh Vite/React/shadcn initialization and recreates the visual language of `../nyanis/ui`: Geist, neutral OKLCH tokens, a subtle gray canvas, compact controls, a blue active accent, Lucide icons, rounded components, dense operational tables, clear status colors, and useful chart primitives. Iroha designs its own workflow and page composition, using continuous divider-led layouts instead of grids of generic summary cards.

## Evidence on Hand

- The provider/protocol vocabulary and provider-specific entitlement behavior in `../nyanis` informed the separation between generic inference compatibility and provider-specific Usage Adapters.
- `../nyanis/ui/src/index.css` and its app-shell, sidebar, table, and detail components are the confirmed visual references for Iroha.
- Primary-source comparisons of OmniRoute, LiteLLM, Portkey, and Bifrost are recorded in `docs/research/gateway-routing-comparison.md`.
- No existing Iroha implementation, visual identity, customer evidence, benchmarks, or production usage exists yet; future work must not fabricate them.

## Product Principles

- Make provider choice explicit and key recovery automatic.
- Be precise about unknown capacity and unsupported provider capabilities.
- Prefer actionable failure state over decorative monitoring.
- Keep inference content private by default.
- Optimize for a self-hosted Owner without closing the door to supported deployment choices.

## Accessibility & Inclusion

The UI is desktop-focused but remains functional on mobile for configuration, health inspection, logs, key disablement, and recovery. Use semantic controls, keyboard support, visible focus, screen-reader labels, and reduced-motion handling as the engineering baseline; a formal accessibility certification is not a version-one product goal.
