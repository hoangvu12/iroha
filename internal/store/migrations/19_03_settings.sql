-- Settings: runtime configuration changed through /api/settings. A row
-- exists only while a setting differs from its built-in default; value is
-- JSON. When and by whom it changed is in the Audit Entries.
CREATE TABLE settings (
    name  TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
