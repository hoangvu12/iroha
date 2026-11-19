-- Audit Entries: one row per change to Iroha's configuration, naming the
-- Admin Token or Owner session that made it. Ordered by rowid (insertion).
CREATE TABLE audit_entries (
    id           TEXT PRIMARY KEY,
    at           INTEGER NOT NULL,
    actor_kind   TEXT NOT NULL,
    actor_id     TEXT NOT NULL,
    actor_name   TEXT NOT NULL,
    action       TEXT NOT NULL,
    summary      TEXT NOT NULL,
    irreversible TEXT,            -- why it cannot be reverted; NULL when it can
    revert_of    TEXT,            -- the entry this one reverted
    reverted_by  TEXT             -- the entry that reverted this one
);
CREATE INDEX audit_entries_at ON audit_entries (at);
CREATE INDEX audit_entries_actor ON audit_entries (actor_id);

-- The records one Audit Entry changed, each with its configuration snapshot
-- before and after (JSON; NULL before = created, NULL after = deleted).
CREATE TABLE audit_changes (
    entry_id    TEXT NOT NULL REFERENCES audit_entries (id) ON DELETE CASCADE,
    seq         INTEGER NOT NULL,
    resource    TEXT NOT NULL,
    record_id   TEXT NOT NULL,
    record_name TEXT NOT NULL,
    before      TEXT,
    after       TEXT,
    PRIMARY KEY (entry_id, seq)
);
CREATE INDEX audit_changes_record ON audit_changes (resource, record_id);
