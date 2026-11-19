-- Providers: one upstream service as the Owner configured it. The handle is
-- unique, immutable and never released (archived Providers keep it).
CREATE TABLE providers (
    id         TEXT PRIMARY KEY,
    handle     TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 1,
    archived   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

-- Endpoints: one URL of a Provider speaking one Shape. Ticket 04 exposes
-- name, url and shape; the other columns are read by the Gateway already and
-- are exposed by ticket 09 (several Endpoints, auth styles, static headers,
-- model renames).
CREATE TABLE endpoints (
    id             TEXT PRIMARY KEY,
    provider_id    TEXT NOT NULL REFERENCES providers (id),
    name           TEXT NOT NULL,
    url            TEXT NOT NULL,              -- base URL including the version path
    shape          TEXT NOT NULL,              -- openai-chat, openai-responses, anthropic-messages, gemini
    auth_style     TEXT NOT NULL DEFAULT 'bearer', -- bearer, x-api-key, header, query, none
    auth_param     TEXT NOT NULL DEFAULT '',   -- header or query parameter name for auth_style header/query
    static_headers TEXT NOT NULL DEFAULT '{}', -- JSON object: header name -> value
    renames        TEXT NOT NULL DEFAULT '{}', -- JSON object: Caller-facing model -> wire model
    created_at     INTEGER NOT NULL,
    UNIQUE (provider_id, name)
);

-- Upstream Keys: secrets issued by a Provider's service, stored readable
-- (ADR-0006). An empty secret is a keyless slot (no auth header is sent).
CREATE TABLE upstream_keys (
    id           TEXT PRIMARY KEY,
    provider_id  TEXT NOT NULL REFERENCES providers (id),
    name         TEXT NOT NULL,
    secret       TEXT NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER,
    UNIQUE (provider_id, name)
);
CREATE INDEX upstream_keys_provider ON upstream_keys (provider_id, created_at);
