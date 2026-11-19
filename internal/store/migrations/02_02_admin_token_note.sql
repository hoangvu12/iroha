-- A free-text note on each Admin Token: who holds it or what it is for.
ALTER TABLE admin_tokens ADD COLUMN note TEXT NOT NULL DEFAULT '';
