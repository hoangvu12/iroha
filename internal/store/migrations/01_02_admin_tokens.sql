-- Admin Tokens: named secrets with full access, stored readable (ADR-0006).
CREATE TABLE admin_tokens (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE,
    secret       TEXT NOT NULL UNIQUE,
    created_at   INTEGER NOT NULL,
    revoked_at   INTEGER,
    last_used_at INTEGER
);
