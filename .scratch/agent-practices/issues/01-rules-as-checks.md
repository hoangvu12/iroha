# 01: Rules as checks

Status: open
Blocked by: none

## Why

`docs/agents/architecture.md` "Rules everyone follows" and the package map state rules in prose ("never call `time.Now`", "`internal/translate` is the only importer of RelayKit", "stdlib `net/http` only", pure packages, `hosts.Of` as the one way to read an Endpoint's host). Agents copy what the code does, not what a doc says; a rule nothing checks drifts. pstack's lesson: encode each repeated correction in structure, with an error message that says what to do instead (`docs/research/pstack-agent-practices.md`, item 1).

## What

- A test-only package (suggested `internal/archtest`) that loads the module's non-test Go files with `go/parser` (or `golang.org/x/tools/go/packages` only if already a dependency; prefer stdlib) and checks rules. Each failure names the file:line, the rule, and the fix (e.g. "use clock.Clock's Now / clock.WithTimeout; see architecture.md, Time").
- Go through "Rules everyone follows" and the package map, and encode every rule a program can check reliably. At least:
  - **Time**: no `time.Now`, `time.Since`, `time.Until`, `time.After`, `time.AfterFunc`, `time.NewTimer`, `time.NewTicker`, `time.Tick`, `time.Sleep`, `context.WithTimeout`, `context.WithDeadline` outside `internal/clock` and `internal/testkit` (and `cmd/` if justified; say why). Find out first which calls exist today; an existing use that is legitimate gets an explicit, commented allow-list entry, not a weakened rule.
  - **Imports**: RelayKit imported only by `internal/translate`; no third-party HTTP router or web framework; the driver `modernc.org/sqlite` only where the store opens it; pure packages named as pure in the package map (`rules`, `planner`, `affinity`, `caching`, `normalise`, `modelmeta`, others it lists) import no `internal/store`, `database/sql` or `net/http` server code (check what "pure" means for each in the map; `net/http` types like `http.Header` may be fine).
  - **Errors** from handlers being `*api.Error`, **secrets never logged**, **JSON snake_case**: encode only if a reliable static check exists (e.g. every `json:"..."` tag in non-test code is snake_case). Skip the rest and say why in the ticket's Comments.
- Then edit "Rules everyone follows": each rule now checked says so in a few words and names the test; drop wording the test makes redundant. Keep rules that need judgement.
- Verify each check catches what it should: for each rule, temporarily introduce a violation, see the test fail with the intended message, remove it. Record that in Comments (no violating code committed).

## Done when

`go vet ./...` and `go test ./...` pass. `## Comments` here lists the rules encoded, the allow-list entries and why, the rules skipped and why, and how each check was seen failing. Commit on your branch; don't merge, push or deploy.
