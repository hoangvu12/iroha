-- Model lists (ticket 10). Owner configuration first: whether a Provider
-- refuses models its list lacks, how its models are discovered, and where
-- each Endpoint's list is read.
ALTER TABLE providers ADD COLUMN strict INTEGER NOT NULL DEFAULT 0;
ALTER TABLE providers ADD COLUMN discovery TEXT NOT NULL DEFAULT 'provider'; -- none, provider (once per Endpoint), key (per key and Endpoint)
ALTER TABLE endpoints ADD COLUMN discovery_url TEXT NOT NULL DEFAULT '';     -- '' = <url>/models, 'none' = never asked, else the URL

-- One entry per model of a Provider's model list. The flags are independent:
-- discovered is "some row in provider_model_sources names it", added and
-- hidden are the Owner's (audited as resource "model"). An entry is deleted
-- only when no flag keeps it. id is derived from (provider_id, model), so an
-- entry dropped and found again keeps its ID and its Audit Entries still
-- apply. reported is the model's object as discovery last received it (JSON),
-- for metadata (ticket 11).
CREATE TABLE provider_models (
    id            TEXT PRIMARY KEY,
    provider_id   TEXT NOT NULL REFERENCES providers (id) ON DELETE CASCADE,
    model         TEXT NOT NULL,
    added         INTEGER NOT NULL DEFAULT 0,
    hidden        INTEGER NOT NULL DEFAULT 0,
    reported      TEXT NOT NULL DEFAULT '',
    discovered_at INTEGER,          -- last refresh whose list named it
    UNIQUE (provider_id, model)
);

-- Which list named which model: an Endpoint's (key_id NULL under
-- per-Provider discovery) or one key's on one Endpoint (per-key discovery).
-- A refresh replaces the rows of each list it read successfully and keeps
-- the rows of lists it failed to read. Deleting the Endpoint or key takes
-- its rows. Runtime state: never audited.
CREATE TABLE provider_model_sources (
    provider_id TEXT NOT NULL REFERENCES providers (id) ON DELETE CASCADE,
    endpoint_id TEXT NOT NULL REFERENCES endpoints (id) ON DELETE CASCADE,
    key_id      TEXT REFERENCES upstream_keys (id) ON DELETE CASCADE,
    model       TEXT NOT NULL,
    seen_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX provider_model_sources_list ON provider_model_sources (provider_id, endpoint_id, ifnull(key_id, ''), model);
CREATE INDEX provider_model_sources_model ON provider_model_sources (provider_id, model);
CREATE INDEX provider_model_sources_key ON provider_model_sources (key_id);

-- The latest refresh of each Provider, for the UI and the daily job (20).
CREATE TABLE model_refreshes (
    provider_id  TEXT PRIMARY KEY REFERENCES providers (id) ON DELETE CASCADE,
    refreshed_at INTEGER NOT NULL,
    outcome      TEXT NOT NULL,   -- ok, partial, failed, skipped
    summary      TEXT NOT NULL DEFAULT ''
);
