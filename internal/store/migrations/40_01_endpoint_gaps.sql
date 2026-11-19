-- Endpoint Gaps (ticket 40): one Upstream Key was refused as invalid on one
-- Endpoint after it had worked on another Endpoint of its Provider, so it is
-- not sent to that Endpoint and keeps serving the others. No expiry: a gap
-- is cleared by the Owner (audited, so id makes it restorable), by an edit of
-- the key's secret or Endpoint restriction, by a passing key test or a
-- successful Attempt on that Endpoint, or when the key becomes invalid.
CREATE TABLE endpoint_gaps (
    id          TEXT PRIMARY KEY,
    key_id      TEXT NOT NULL REFERENCES upstream_keys (id) ON DELETE CASCADE,
    endpoint_id TEXT NOT NULL REFERENCES endpoints (id) ON DELETE CASCADE,
    reason      TEXT NOT NULL,
    rule        TEXT NOT NULL DEFAULT '',
    request_id  TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    UNIQUE (key_id, endpoint_id)
);
CREATE INDEX endpoint_gaps_endpoint ON endpoint_gaps (endpoint_id);

-- Where each Upstream Key has worked: the latest 2xx Attempt or passing key
-- test per key and Endpoint, written at most once a minute per pair (like
-- last_used_at). Runtime state: a new secret deletes the key's rows.
CREATE TABLE key_endpoint_successes (
    key_id       TEXT NOT NULL REFERENCES upstream_keys (id) ON DELETE CASCADE,
    endpoint_id  TEXT NOT NULL REFERENCES endpoints (id) ON DELETE CASCADE,
    succeeded_at INTEGER NOT NULL,
    PRIMARY KEY (key_id, endpoint_id)
);
CREATE INDEX key_endpoint_successes_endpoint ON key_endpoint_successes (endpoint_id);
