-- Restriction of an Upstream Key to some Endpoints of its Provider. A key
-- without rows here may use every Endpoint. Deleting a key takes its rows;
-- an Endpoint cannot be deleted while a row names it (the admin API removes
-- the rows first, as part of the audited change).
CREATE TABLE upstream_key_endpoints (
    key_id      TEXT NOT NULL REFERENCES upstream_keys (id) ON DELETE CASCADE,
    endpoint_id TEXT NOT NULL REFERENCES endpoints (id),
    PRIMARY KEY (key_id, endpoint_id)
);
CREATE INDEX upstream_key_endpoints_endpoint ON upstream_key_endpoints (endpoint_id);
