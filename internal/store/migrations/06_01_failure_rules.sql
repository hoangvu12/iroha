-- Failure Rules the Owner (or an agent) added, overrode or switched off.
-- Built-in rules live in the binary (internal/rules/builtin.go); a row here
-- with the name of a built-in overrides it. definition is the rule as JSON;
-- NULL means "the built-in rule of this name as shipped", so switching a
-- built-in off does not freeze its definition. Owner rules are tried in
-- rowid order (the order they were added). When and by whom a rule changed
-- is in the Audit Entries.
CREATE TABLE failure_rules (
    name       TEXT PRIMARY KEY,
    enabled    INTEGER NOT NULL DEFAULT 1,
    definition TEXT,
    id         TEXT GENERATED ALWAYS AS (name) VIRTUAL -- the audit record ID is the name
);

-- A counter every committed change to failure_rules bumps, so the Gateway
-- notices any change (API, revert) with one cheap read per Request.
CREATE TABLE failure_rules_version (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    n  INTEGER NOT NULL
);
INSERT INTO failure_rules_version (id, n) VALUES (1, 0);

CREATE TRIGGER failure_rules_inserted AFTER INSERT ON failure_rules
BEGIN UPDATE failure_rules_version SET n = n + 1 WHERE id = 1; END;
CREATE TRIGGER failure_rules_updated AFTER UPDATE ON failure_rules
BEGIN UPDATE failure_rules_version SET n = n + 1 WHERE id = 1; END;
CREATE TRIGGER failure_rules_deleted AFTER DELETE ON failure_rules
BEGIN UPDATE failure_rules_version SET n = n + 1 WHERE id = 1; END;

-- Recent failed (classified) Attempts: rule hit counts and dry-run replays.
CREATE INDEX attempts_classified ON attempts (started_at) WHERE outcome != '';
