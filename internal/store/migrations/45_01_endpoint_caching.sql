-- Caching across Shapes (prompt-caching ticket 03).

-- Per Endpoint, for requests translated to it: cache_markers ('' Iroha's
-- default for the Endpoint's Shape and host, 'on', 'off') says whether cache
-- markers are added or kept; send_prompt_cache_key (same values) whether an
-- OpenAI-shaped Endpoint is sent a prompt_cache_key derived from the
-- conversation. Same-Shape passthrough is never changed by either.
ALTER TABLE endpoints ADD COLUMN cache_markers TEXT NOT NULL DEFAULT '';
ALTER TABLE endpoints ADD COLUMN send_prompt_cache_key TEXT NOT NULL DEFAULT '';
