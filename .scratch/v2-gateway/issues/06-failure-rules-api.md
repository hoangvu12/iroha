# 06: Failure Rules managed by agents

**What to build:** Agents list, add, override (by name) and delete Failure Rules through the admin API, scoped to a Provider or global, matching on status, error code, body text and headers, with an outcome and an optional cooling duration or reset-time extraction. A dry run replays recent failed Attempts and reports which would match and what would change. Changes take effect without restart.

**Blocked by:** 05

**Status:** done

- [x] Owner rules override built-ins by name; built-ins are listed but cannot be deleted
- [x] Dry run against recent failed Attempts reports matches per rule
- [x] Rules apply to the next Attempt after a change
- [x] Every rule change writes an Audit Entry

## Comments

Built `internal/failurerules`: `/api/rules` (list with `?provider=` and `?since=`, read, create-or-override by name, PATCH, DELETE, `/enable`, `/disable`, and bulk create/delete/enable/disable) on the audit machinery as resource `failure_rule` (record ID = rule name). Storage is `failure_rules` (migration `06_01`): a row only while a rule differs from its built-in; a built-in switched off stores no definition, so later built-in fixes still reach it. Triggers bump `failure_rules_version`; `Store.Set` (wired as `gateway.Options.Rules`, the only gateway change besides a comment) re-reads only when it moves, so API changes and reverts apply to the next Request. Each list item carries what the C09 Rules tab needs: `status`, `code`/`body`, `key_effect` ("Cool 60 s", "Mark invalid"...), `request_effect` ("Try next key"/"Return to Caller"), `hits` and `last_hit_at` (from `attempts.rule`, default last 24 h), `source` (`builtin`/`owner`, with `overrides` showing the replaced built-in), `enabled`, `order`. Single-rule dry runs return `replay` (latest 1000 classified Attempts in 7 days, now vs after, per-rule counts, up to 20 changed examples); bulk dry runs report changes only. Skill text in `internal/api/skill/26_failure_rules.md`.

Not done here: the UI Rules tab (provider pages, ticket 22).
