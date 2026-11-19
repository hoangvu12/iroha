-- Structured log events, mirrored from stdout and read through GET /api/logs.
-- level is the slog level number (debug -4, info 0, warn 4, error 8).
CREATE TABLE log_events (
    id         INTEGER PRIMARY KEY,
    at         INTEGER NOT NULL,
    level      INTEGER NOT NULL,
    kind       TEXT NOT NULL,
    message    TEXT NOT NULL,
    request_id TEXT,
    provider   TEXT,
    attrs      TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX log_events_at ON log_events (at);
CREATE INDEX log_events_kind_at ON log_events (kind, at);
CREATE INDEX log_events_request ON log_events (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX log_events_provider_at ON log_events (provider, at) WHERE provider IS NOT NULL;
