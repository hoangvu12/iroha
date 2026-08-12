# 16 — Exception-first operations workspace

**What to build:** The completed management UI lets an occasional Owner identify and repair operational problems quickly without a generic card-grid dashboard.

**Blocked by:** 10 — Scoped retries and durable Key Health; 11 — Usage Adapter and entitlement visibility; 13 — Private request history and Owner audit; 14 — Bounded background operations.

**Status:** ready-for-agent

- [ ] Primary navigation provides Overview, Providers, Gateway Keys, Requests, Audit, and Settings.
- [ ] Provider Connection detail provides Overview, Upstream Keys, Models, Usage, Logs, and Settings without duplicating global navigation.
- [ ] Overview leads with attention-required rows and direct Refresh, Test, Enable, and Disable actions.
- [ ] Compact inline summaries, one quiet request-volume trend, one Key Health distribution, and recent failures replace a grid of summary cards.
- [ ] The UI uses fresh shadcn components with the agreed nyanis-inspired typography, tokens, density, status colors, tables, details, and selectively ported chart primitives.
- [ ] Light, dark, and system themes work and maintain readable operational/status contrast.
- [ ] Desktop editing is efficient; setup, inspection, logs, key disablement, and recovery remain functional on mobile.
- [ ] Loading, empty, stale, partial-failure, destructive-confirmation, and permission states provide specific recovery guidance.
- [ ] Browser tests cover keyboard operation, visible focus, screen-reader naming, reduced motion, themes, desktop, and mobile workflows.

