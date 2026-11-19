-- Stored times are named *_at (architecture.md "Rules everyone follows"):
-- the two tables that used a bare "at" follow it. Indexes follow the rename.
ALTER TABLE log_events RENAME COLUMN at TO logged_at;
ALTER TABLE audit_entries RENAME COLUMN at TO created_at;
