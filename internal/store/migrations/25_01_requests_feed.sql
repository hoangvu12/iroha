-- The live Requests feed. rev is a change counter: every insert or update
-- of a Request (and storing its capture) gives it the next rev, so
-- GET /api/requests?changed_after=<cursor> returns exactly what started or
-- changed since a reader last looked. Triggers keep it, so no writer has to.
ALTER TABLE requests ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
UPDATE requests SET rev = rowid;
CREATE INDEX requests_rev ON requests (rev);

-- The Model Pool the Caller asked for, when it named one (ticket 18 writes it).
ALTER TABLE requests ADD COLUMN pool TEXT NOT NULL DEFAULT '';
CREATE INDEX requests_pool ON requests (pool, started_at);

CREATE TRIGGER requests_rev_insert AFTER INSERT ON requests
BEGIN
    UPDATE requests SET rev = (SELECT coalesce(max(rev), 0) + 1 FROM requests) WHERE id = NEW.id;
END;

CREATE TRIGGER requests_rev_update AFTER UPDATE ON requests WHEN NEW.rev = OLD.rev
BEGIN
    UPDATE requests SET rev = (SELECT coalesce(max(rev), 0) + 1 FROM requests) WHERE id = NEW.id;
END;

CREATE TRIGGER captures_rev_insert AFTER INSERT ON captures
BEGIN
    UPDATE requests SET rev = (SELECT coalesce(max(rev), 0) + 1 FROM requests) WHERE id = NEW.request_id;
END;
