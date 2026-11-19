-- Model Gaps: one Upstream Key was refused one (wire) model, so that model is
-- not sent to that key until expires_at (created + 24 h) or until the gap is
-- cleared (key test, key edit, by hand, discovery). Expired rows are deleted
-- lazily and logged as model_gap op=expired. id makes a cleared gap
-- restorable through its Audit Entry.
CREATE TABLE model_gaps (
    id         TEXT PRIMARY KEY,
    key_id     TEXT NOT NULL REFERENCES upstream_keys (id) ON DELETE CASCADE,
    model      TEXT NOT NULL,
    reason     TEXT NOT NULL,
    rule       TEXT NOT NULL DEFAULT '',
    request_id TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    UNIQUE (key_id, model)
);
