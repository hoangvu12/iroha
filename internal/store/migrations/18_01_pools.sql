-- Model Pools (ticket 18): a model name Callers ask for on the global
-- routes, served by its members in order. Names have no slash and never
-- collide, whatever their case. maker is the Owner's choice of model maker
-- (for the logo); '' means guessed from the members' model name.
-- max_attempts and first_byte_seconds override the Request budget for the
-- whole Pool; 0 keeps the serving Providers' own.
CREATE TABLE pools (
    id                 TEXT PRIMARY KEY,
    name               TEXT NOT NULL UNIQUE COLLATE NOCASE,
    maker              TEXT NOT NULL DEFAULT '',
    max_attempts       INTEGER NOT NULL DEFAULT 0,
    first_byte_seconds INTEGER NOT NULL DEFAULT 0,
    created_at         INTEGER NOT NULL
);

-- Members in try order (position 1 first). A switched-off member stays in
-- the Pool and is reported by the route preview, but never planned.
CREATE TABLE pool_members (
    pool_id     TEXT NOT NULL REFERENCES pools (id),
    position    INTEGER NOT NULL,
    provider_id TEXT NOT NULL REFERENCES providers (id),
    model       TEXT NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (pool_id, position)
);
CREATE INDEX pool_members_provider ON pool_members (provider_id);
