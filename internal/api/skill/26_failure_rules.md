## Managing Failure Rules

Failure Rules are data you can change at runtime; a change applies to the next Attempt, with no restart. `GET /api/rules` lists every rule in the order they are tried (rules limited to a Provider or host first, then your new rules, then the built-ins), each with `enabled`, `source` (`builtin` or `owner`), `key_effect`, `request_effect` and `hits` (Attempts it decided in the last 24 h, or since `?since=`). `?provider=<handle>` narrows the list to the rules that can apply to that Provider and counts hits on it alone.

**Turn a new failure into a rule.** Read the failed Attempt in `GET /api/requests/<id>` (`status`, `failure_body`, `failure_headers`, and the `rule` it matched), then write a rule that matches it and dry-run it first:

```
POST /api/rules?dry_run=true
{"name": "dashscope-arrears", "provider": "dashscope", "status": ["400"], "code": ["Arrearage"],
 "outcome": "cooling_key", "cooling_seconds": 3600,
 "description": "Account in arrears: the key is refused until it is topped up."}
```

A dry run of any single-rule change (`POST /api/rules`, `PATCH`, `DELETE`, `/enable`, `/disable`) answers with `replay`: the most recent failed Attempts (up to 1000, last 7 days) classified by the rules as they are (`now`) and as they would be (`after`), with counts per rule and up to 20 `examples` of Attempts whose decision would change. Check that `changed` covers the failures you meant and nothing else, then send the same call without `dry_run`.

A rule matches when every condition it gives holds: `status` (any of `429`, `5xx`, `network`, `timeout`), `code` (any of the Provider's error codes, compared without case against `error.code`, `error.type`, `error.status`, `code`, `type`), `body` (a case-insensitive regular expression; a plain word works), `header` (`{"X-Name": "regexp"}`, empty value for presence). `provider` limits it to one Provider, `host` to Endpoints on that host or its subdomains. For cooling outcomes, `cooling_seconds` fixes the cooling when the response names no reset time, and `reset` (`header:<name>` or `json:<dotted.path>`) says where the response names it.

**Override, switch off, restore.** `POST /api/rules` with a built-in rule's name overrides it: fields you leave out keep the built-in's values, and the rule then shows `source: owner` with the built-in under `overrides`. `POST /api/rules/<name>/disable` and `/enable` switch any rule, built-in ones included. Built-in rules cannot be deleted (409 `builtin_rule`); `DELETE /api/rules/<name>` deletes your rule, or drops your override or switch so the built-in stands as shipped. Every change is an Audit Entry (`GET /api/audit-entries?resource=failure_rule`) and can be reverted.
