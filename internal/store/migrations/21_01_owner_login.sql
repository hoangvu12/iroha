-- Owner login (ticket 21): one Owner password and the Owner's browser
-- sessions. The password is stored as a PBKDF2 hash and session secrets as
-- SHA-256 hashes: unlike Admin Tokens (ADR-0006) nobody ever needs to read
-- them back.
CREATE TABLE owner_password (
    id     TEXT PRIMARY KEY CHECK (id = 'owner'),
    name   TEXT NOT NULL DEFAULT 'Owner password',
    hash   TEXT NOT NULL,
    set_at INTEGER NOT NULL
);

CREATE TABLE owner_sessions (
    id           TEXT PRIMARY KEY,
    secret_hash  TEXT NOT NULL UNIQUE,
    user_agent   TEXT NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    last_seen_at INTEGER,
    revoked_at   INTEGER
);
