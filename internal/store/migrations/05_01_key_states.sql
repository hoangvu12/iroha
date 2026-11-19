-- Owner-set configuration: a disabled Upstream Key gets no traffic until
-- enabled. disabled_by/disabled_at say who and when (not audited fields).
ALTER TABLE upstream_keys ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE upstream_keys ADD COLUMN disabled_by TEXT NOT NULL DEFAULT '';
ALTER TABLE upstream_keys ADD COLUMN disabled_at INTEGER;

-- Per-Provider Request budget overrides; 0 means the default (3 Attempts,
-- 60 s to first byte). The time never exceeds the 95 s ceiling.
ALTER TABLE providers ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE providers ADD COLUMN first_byte_seconds INTEGER NOT NULL DEFAULT 0;

-- Runtime Key State of an Upstream Key (no row: active since it was added).
-- state is active, invalid or cooling; disabled comes from upstream_keys.
-- level counts repeated coolings (60 s doubling up to 1 h).
CREATE TABLE key_states (
    key_id     TEXT PRIMARY KEY REFERENCES upstream_keys (id) ON DELETE CASCADE,
    state      TEXT NOT NULL,
    reason     TEXT NOT NULL,
    rule       TEXT NOT NULL DEFAULT '',
    request_id TEXT NOT NULL DEFAULT '',
    since_at   INTEGER NOT NULL,
    until_at   INTEGER,
    level      INTEGER NOT NULL DEFAULT 0
);

-- Cooling of one Upstream Key for one (wire) model. Rows outlive their
-- until_at so repeats can double and escalation can count distinct models.
CREATE TABLE key_model_cooling (
    key_id     TEXT NOT NULL REFERENCES upstream_keys (id) ON DELETE CASCADE,
    model      TEXT NOT NULL,
    reason     TEXT NOT NULL,
    rule       TEXT NOT NULL DEFAULT '',
    request_id TEXT NOT NULL DEFAULT '',
    since_at   INTEGER NOT NULL,
    until_at   INTEGER NOT NULL,
    level      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (key_id, model)
);

-- What each failed Attempt matched and did, with the failure itself.
ALTER TABLE attempts ADD COLUMN rule TEXT NOT NULL DEFAULT '';
ALTER TABLE attempts ADD COLUMN outcome TEXT NOT NULL DEFAULT '';
ALTER TABLE attempts ADD COLUMN reason TEXT NOT NULL DEFAULT '';
ALTER TABLE attempts ADD COLUMN action TEXT NOT NULL DEFAULT '';
ALTER TABLE attempts ADD COLUMN failure_headers TEXT NOT NULL DEFAULT '';
ALTER TABLE attempts ADD COLUMN failure_body TEXT NOT NULL DEFAULT '';
CREATE INDEX attempts_provider ON attempts (provider_id, started_at);

-- One line saying what happened across a Request's Attempts.
ALTER TABLE requests ADD COLUMN summary TEXT NOT NULL DEFAULT '';
