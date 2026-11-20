-- Conversation affinity (prompt-caching ticket 02).

-- Per Provider: 'on' ranks its Upstream Keys for each conversation, so the
-- turns of one conversation land on one key; 'off' keeps round-robin. On for
-- every Provider by default (Owner, 2026-11-20).
ALTER TABLE providers ADD COLUMN affinity TEXT NOT NULL DEFAULT 'on';

-- Per Request: where the conversation's identity came from (header,
-- claude_code, codex, session_id, opencode, prompt_cache_key, prefix, none),
-- whether affinity ordered the keys (on; off: the Provider's switch;
-- control: the experiment's round-robin half; none: no conversation), and
-- whether the key affinity put first answered (NULL when not applicable).
-- '' on Requests from before, or refused before planning.
ALTER TABLE requests ADD COLUMN affinity_source TEXT NOT NULL DEFAULT '';
ALTER TABLE requests ADD COLUMN affinity TEXT NOT NULL DEFAULT '';
ALTER TABLE requests ADD COLUMN affinity_preferred INTEGER;
