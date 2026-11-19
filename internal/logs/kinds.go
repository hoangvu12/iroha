// Package logs is Iroha's structured logging: a slog handler that writes
// each event to the console and to the log_events table, and the
// GET /api/logs route that reads them back.
//
// Every event has a kind. Declare kinds as package-level variables in the
// package that emits them, so parallel work never edits a shared list:
//
//	var KindRefreshRun = logs.NewKind("refresh.run", "A Provider's model list refresh finished.")
//	log.Info("model refresh finished", logs.Kind(KindRefreshRun), logs.Provider(handle), "models", n)
package logs

import (
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync"
)

// Attribute keys the store lifts into their own columns. Only top-level
// attributes (not inside a group) are lifted.
const (
	KindKey     = "kind"
	RequestKey  = "request_id"
	ProviderKey = "provider"
)

// DefaultKind is stored for events logged without a kind.
const DefaultKind = "log"

// EventKind is a registered kind of log event.
type EventKind struct {
	Name        string
	Description string
}

var (
	kindsMu sync.Mutex
	kinds   = map[string]EventKind{}
)

// NewKind registers an event kind. Call it from a package-level var; it
// panics on a duplicate name.
func NewKind(name, description string) EventKind {
	kindsMu.Lock()
	defer kindsMu.Unlock()
	if _, ok := kinds[name]; ok {
		panic(fmt.Sprintf("logs: kind %q registered twice", name))
	}
	k := EventKind{Name: name, Description: description}
	kinds[name] = k
	return k
}

// Kinds returns every registered kind, sorted by name.
func Kinds() []EventKind {
	kindsMu.Lock()
	defer kindsMu.Unlock()
	out := make([]EventKind, 0, len(kinds))
	for _, k := range kinds {
		out = append(out, k)
	}
	slices.SortFunc(out, func(a, b EventKind) int { return strings.Compare(a.Name, b.Name) })
	return out
}

// Kind is the slog attribute for an event kind.
func Kind(k EventKind) slog.Attr { return slog.String(KindKey, k.Name) }

// Request is the slog attribute linking an event to a Request.
func Request(id string) slog.Attr { return slog.String(RequestKey, id) }

// Provider is the slog attribute linking an event to a Provider (by handle).
func Provider(handle string) slog.Attr { return slog.String(ProviderKey, handle) }

// Kinds emitted by the core.
var (
	KindStartup   = NewKind("startup", "Iroha started: version, listen address, data directory, migrations applied.")
	KindShutdown  = NewKind("shutdown", "Iroha is stopping: reason and how long draining took.")
	KindMigration = NewKind("migration", "A database migration was applied, or an applied one was found edited.")
	// http.error and http.panic are emitted by package api, which cannot
	// import this package; it uses the same names.
	KindHTTPError = NewKind("http.error", "An API route failed with an internal error.")
	KindHTTPPanic = NewKind("http.panic", "An API route panicked; includes the stack.")
	KindGeneric   = NewKind(DefaultKind, "An event logged without a specific kind.")
)

// Kinds shared by several packages, registered here so parallel work never
// registers one twice. Emit them with the attributes their descriptions
// name (docs/agents/architecture.md, "Log event kinds"):
//
//	log.Warn("Upstream Key cooling", logs.Kind(logs.KindKeyState), logs.Provider(handle), logs.Request(reqID),
//		"upstream_key", key.Name, "state", "cooling", "model", model, "until", until, "reason", reason)
var (
	KindRuleMatch = NewKind("rule.match", "A Failure Rule matched a failed Attempt: rule, action, attempt (seq), upstream_key, model, status. Linked to the Request and Provider.")
	KindKeyState  = NewKind("key.state", "An Upstream Key's Key State changed: upstream_key, from, state (active, disabled, invalid, cooling), model when only one model cools, until, reason. Linked to the Provider, and to the Request that caused it.")
	KindModelGap  = NewKind("model_gap", "A Model Gap was created, cleared or expired: op (created, cleared, expired), upstream_key, model, reason, until. Linked to the Provider, and to the Request that caused it.")
	KindDiscovery = NewKind("discovery", "A model discovery run finished for a Provider, or one of its Endpoints or keys: endpoint, upstream_key, outcome (ok, failed), found, added, removed, or the error. Linked to the Provider.")
	KindJobRun    = NewKind("job.run", "A background job ran: job, trigger (schedule, manual), dry_run, outcome (ok, failed, canceled), duration_ms, summary and the job's own figures. Linked to a Provider when the run concerned one.")
)

// SkillSection lists the registered kinds for the served skill.
func SkillSection() string {
	var b strings.Builder
	b.WriteString("## Log event kinds\n\nFilter `GET /api/logs` with `kind=`. Registered kinds:\n\n")
	for _, k := range Kinds() {
		fmt.Fprintf(&b, "- `%s`: %s\n", k.Name, k.Description)
	}
	return b.String()
}
