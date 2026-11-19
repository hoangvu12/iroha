-- Gateway Keys: secrets Iroha issues to Callers, stored readable (ADR-0006).
-- scope is JSON: {"all": true} or {"all": false, "providers": [{"provider_id":
-- "pr_...", "models": ["..."]}]} (models omitted = every model). Ticket 18
-- adds "pools" to the same object.
CREATE TABLE gateway_keys (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE,
    secret       TEXT NOT NULL UNIQUE,
    scope        TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    revoked_at   INTEGER,
    last_used_at INTEGER
);
