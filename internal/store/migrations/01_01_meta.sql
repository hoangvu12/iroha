-- Internal facts about this installation (for example whether the bootstrap
-- Admin Token was issued). Not Owner settings.
CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
