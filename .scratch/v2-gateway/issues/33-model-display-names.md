# 33: Model display names

**What to build:** v1 sent a display name (`normalized_name`) on both model lists (catalog MOD-67); v2 has none: `modelmeta.Facts` lacks a name and `Normalize` ignores `normalized_name`, `display_name` and `name`. Add `name` to `modelmeta.Facts`, read from the Provider's list (`normalized_name`, `display_name`, `name`, skipping Gemini's `models/...` paths) and from models.dev's `name`, overridable by the Owner, emitted on `/v1/models` and `/providers/{handle}/v1/models`. Spec story 24 does not list it, so first confirm that Pi or OpenCode setups use it.

**Blocked by:** none

**Status:** needs-decision (do Callers need it?)

- [ ] `modelmeta` table cases for the aliases and precedence
- [ ] `models` HTTP test: both lists carry the name; an Owner override wins
