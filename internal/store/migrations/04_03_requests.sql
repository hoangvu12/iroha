-- Requests: one exchange between a Caller and the Gateway, described by what
-- the Caller received. Written as in_progress when the Caller is known and
-- completed when the answer ends. Names (caller, Provider handle, Endpoint,
-- Upstream Key) are snapshots, so history never changes when configuration
-- does; there are no foreign keys to configuration.
CREATE TABLE requests (
    id                TEXT PRIMARY KEY,
    started_at        INTEGER NOT NULL,
    finished_at       INTEGER,
    state             TEXT NOT NULL,              -- in_progress, completed
    status            INTEGER NOT NULL DEFAULT 0, -- HTTP status the Caller received
    error_code        TEXT NOT NULL DEFAULT '',
    error_message     TEXT NOT NULL DEFAULT '',
    caller_kind       TEXT NOT NULL,              -- gateway_key
    gateway_key_id    TEXT NOT NULL DEFAULT '',
    caller_name       TEXT NOT NULL,
    route             TEXT NOT NULL,              -- the path the Caller used
    shape_in          TEXT NOT NULL,
    shape_out         TEXT NOT NULL DEFAULT '',
    model             TEXT NOT NULL DEFAULT '',   -- as the Caller named it
    stream            INTEGER NOT NULL DEFAULT 0,
    provider_id       TEXT NOT NULL DEFAULT '',
    provider_handle   TEXT NOT NULL DEFAULT '',
    endpoint_id       TEXT NOT NULL DEFAULT '',
    endpoint_name     TEXT NOT NULL DEFAULT '',
    upstream_key_id   TEXT NOT NULL DEFAULT '',
    upstream_key_name TEXT NOT NULL DEFAULT '',
    wire_model        TEXT NOT NULL DEFAULT '',
    first_byte_ms     INTEGER,
    duration_ms       INTEGER,
    input_tokens      INTEGER,
    output_tokens     INTEGER,
    cache_read_tokens INTEGER,
    reasoning_tokens  INTEGER,
    attempt_count     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX requests_started ON requests (started_at);
CREATE INDEX requests_gateway_key ON requests (gateway_key_id, started_at);
CREATE INDEX requests_provider ON requests (provider_handle, started_at);

-- Attempts: one transmission to a Provider with one Upstream Key.
CREATE TABLE attempts (
    request_id        TEXT NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
    seq               INTEGER NOT NULL,           -- 1, 2, 3 in the order made
    started_at        INTEGER NOT NULL,
    provider_id       TEXT NOT NULL,
    provider_handle   TEXT NOT NULL,
    endpoint_id       TEXT NOT NULL,
    endpoint_name     TEXT NOT NULL,
    endpoint_url      TEXT NOT NULL,
    upstream_key_id   TEXT NOT NULL,
    upstream_key_name TEXT NOT NULL,
    wire_model        TEXT NOT NULL,
    shape             TEXT NOT NULL,
    status            INTEGER NOT NULL DEFAULT 0, -- upstream HTTP status; 0 when none arrived
    error             TEXT NOT NULL DEFAULT '',
    first_byte_ms     INTEGER,
    duration_ms       INTEGER,
    input_tokens      INTEGER,
    output_tokens     INTEGER,
    cache_read_tokens INTEGER,
    reasoning_tokens  INTEGER,
    PRIMARY KEY (request_id, seq)
);
