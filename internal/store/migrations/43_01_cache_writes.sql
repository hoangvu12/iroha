-- Prompt caching 01: tokens written to the Provider's prompt cache, beside
-- cache_read_tokens; both are parts of input_tokens. cache_write_long_tokens
-- is the part of the writes kept for the Provider's longer lifetime
-- (Anthropic's 1 h, OpenAI's 12 h), which is billed higher; a column rather
-- than JSON so stats can sum it. NULL on Requests recorded before this, and
-- whenever input_tokens is NULL.
ALTER TABLE requests ADD COLUMN cache_write_tokens INTEGER;
ALTER TABLE requests ADD COLUMN cache_write_long_tokens INTEGER;
ALTER TABLE attempts ADD COLUMN cache_write_tokens INTEGER;
ALTER TABLE attempts ADD COLUMN cache_write_long_tokens INTEGER;
