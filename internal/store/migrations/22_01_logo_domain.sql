-- The site a Provider's logo is looked up for (ticket 22). '' = guessed from
-- the first Endpoint's host; 'none' = no logo (the UI draws a lettered tile).
ALTER TABLE providers ADD COLUMN logo_domain TEXT NOT NULL DEFAULT '';
