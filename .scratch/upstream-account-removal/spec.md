# Remove Upstream Account grouping

Status: Proposed follow-up

## Decision

The Owner does not find manual grouping of Upstream Keys into an Upstream Account useful and wants each key treated independently. Removal is intentionally separate from MiniMax capacity reconciliation because ADR 0003, persisted account identifiers, health scopes, routing, HTTP views, and UI may require migration.

## Required investigation

- Find every persisted account field and account-scoped health record.
- Determine whether any production keys are currently grouped.
- Define database migration and compatibility behavior for existing records.
- Remove or supersede the Upstream Account glossary entry and ADR 0003 only when the migration decision is accepted.
