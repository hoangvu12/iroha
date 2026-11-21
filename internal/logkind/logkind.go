package logkind

import (
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync"
)

const Key = "kind"

type EventKind struct {
	Name        string
	Description string
}

var (
	mu    sync.Mutex
	kinds = map[string]EventKind{}
)

// New registers an event kind. Call it from a package-level var; it panics
// on a duplicate name.
func New(name, description string) EventKind {
	mu.Lock()
	defer mu.Unlock()
	if _, ok := kinds[name]; ok {
		panic(fmt.Sprintf("logs: kind %q registered twice", name))
	}
	k := EventKind{Name: name, Description: description}
	kinds[name] = k
	return k
}

// All returns every registered kind, sorted by name.
func All() []EventKind {
	mu.Lock()
	defer mu.Unlock()
	out := make([]EventKind, 0, len(kinds))
	for _, k := range kinds {
		out = append(out, k)
	}
	slices.SortFunc(out, func(a, b EventKind) int { return strings.Compare(a.Name, b.Name) })
	return out
}

// Attr is the slog attribute for an event kind.
func Attr(k EventKind) slog.Attr { return slog.String(Key, k.Name) }

var (
	HTTPError = New("http.error", "An API route failed with an internal error.")
	HTTPPanic = New("http.panic", "An API route panicked; includes the stack.")
)
