-- Anthropic-compatible Providers legitimately use `/anthropic/` in their
-- upstream base URL. An obsolete live-database guard from before typed
-- Anthropic support rejected those keys even though it is not part of the
-- current Drizzle schema. Drop it conditionally so both drifted installations
-- and clean installations migrate safely.
ALTER TABLE "upstream_keys"
  DROP CONSTRAINT IF EXISTS "upstream_keys_no_anthropic_path";
