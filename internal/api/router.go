package api

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"runtime/debug"
	"slices"
	"strings"
	"sync"
)

// Router owns the route table and the ServeMux built from it.
type Router struct {
	mux      *http.ServeMux
	routes   []Route
	auth     []Authenticator
	log      *slog.Logger
	fallback http.Handler

	mu sync.RWMutex // guards routes after startup (Add is normally startup-only)
}

// NewRouter returns an empty Router. Authenticators are tried in order for
// AuthAdmin routes.
func NewRouter(log *slog.Logger, auth ...Authenticator) *Router {
	return &Router{mux: http.NewServeMux(), auth: auth, log: log}
}

// Add registers routes. It panics on a malformed or duplicate route, which
// surfaces as a failing test rather than a silent drift.
func (rt *Router) Add(routes ...Route) {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	for _, r := range routes {
		if err := validate(r); err != nil {
			panic(err)
		}
		for _, existing := range rt.routes {
			if existing.Pattern() == r.Pattern() {
				panic(fmt.Sprintf("api: duplicate route %s", r.Pattern()))
			}
		}
		rt.mux.Handle(r.Pattern(), rt.wrap(r))
		rt.routes = append(rt.routes, r)
	}
}

func validate(r Route) error {
	switch r.Method {
	case http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
	default:
		return fmt.Errorf("api: route %q: unsupported method %q", r.Path, r.Method)
	}
	if !strings.HasPrefix(r.Path, "/") {
		return fmt.Errorf("api: route %s: path must start with /", r.Pattern())
	}
	if (r.Handle == nil) == (r.Raw == nil) {
		return fmt.Errorf("api: route %s: set exactly one of Handle and Raw", r.Pattern())
	}
	if r.Summary == "" && !r.Hidden {
		return fmt.Errorf("api: route %s: Summary is required", r.Pattern())
	}
	if r.Hidden && strings.HasPrefix(r.Path, "/api/") {
		return fmt.Errorf("api: route %s: /api/ routes cannot be hidden", r.Pattern())
	}
	return nil
}

// Routes returns a copy of the route table in registration order.
func (rt *Router) Routes() []Route {
	rt.mu.RLock()
	defer rt.mu.RUnlock()
	return slices.Clone(rt.routes)
}

// ServeHTTP dispatches to the matching route. Unknown /api/ paths and wrong
// methods get JSON errors with a hint instead of the ServeMux text pages.
func (rt *Router) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if _, pattern := rt.mux.Handler(r); pattern != "" {
		rt.mux.ServeHTTP(w, r)
		return
	}
	allowed := rt.allowedMethods(r)
	if len(allowed) == 0 && rt.fallback != nil && (r.Method == http.MethodGet || r.Method == http.MethodHead) &&
		!strings.HasPrefix(r.URL.Path, "/api/") {
		rt.fallback.ServeHTTP(w, r)
		return
	}
	if len(allowed) > 0 {
		w.Header().Set("Allow", strings.Join(allowed, ", "))
		WriteError(w, Errorf(http.StatusMethodNotAllowed, "method_not_allowed",
			fmt.Sprintf("Use %s; GET /api/openapi.json lists every route.", strings.Join(allowed, " or ")),
			"%s is not allowed on %s.", r.Method, r.URL.Path))
		return
	}
	NotFoundHandler(w, r)
}

// NotFoundHandler answers the JSON 404 of an unknown route.
func NotFoundHandler(w http.ResponseWriter, r *http.Request) {
	WriteError(w, NotFound("GET /api/openapi.json lists every route; GET /skill.md explains them.", "No route %s %s.", r.Method, r.URL.Path))
}

// Fallback sets the handler for GET and HEAD requests outside /api/ that
// match no route: the embedded UI. It answers unknown paths itself (with
// NotFoundHandler when they are not UI pages).
func (rt *Router) Fallback(h http.Handler) {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	rt.fallback = h
}

func (rt *Router) allowedMethods(r *http.Request) []string {
	var out []string
	for _, m := range []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete} {
		probe := &http.Request{Method: m, URL: &url.URL{Path: r.URL.Path, RawPath: r.URL.RawPath}, Host: r.Host, Header: http.Header{}}
		if _, pattern := rt.mux.Handler(probe); pattern != "" {
			out = append(out, m)
		}
	}
	return out
}

func (rt *Router) wrap(route Route) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if p := recover(); p != nil {
				if p == http.ErrAbortHandler {
					panic(p)
				}
				rt.log.Error("handler panicked", "kind", "http.panic", "route", route.Pattern(), "panic", fmt.Sprint(p), "stack", string(debug.Stack()))
				WriteError(w, AsError(fmt.Errorf("panic")))
			}
		}()
		var actor Actor
		if route.Auth == AuthAdmin {
			a, err := rt.authenticate(r)
			if err != nil {
				WriteError(w, AsError(err))
				return
			}
			actor = *a
			r = r.WithContext(WithActor(r.Context(), actor))
		}
		if route.Raw != nil {
			route.Raw.ServeHTTP(w, r)
			return
		}
		c := &Call{W: w, R: r, Actor: actor, status: route.Status}
		out, err := route.Handle(c)
		if err != nil {
			e := AsError(err)
			if e.Status >= 500 {
				rt.log.Error("admin route failed", "kind", "http.error", "route", route.Pattern(), "err", err.Error())
			}
			WriteError(w, e)
			return
		}
		status := c.status
		if status == 0 {
			status = http.StatusOK
		}
		if out == nil && status == http.StatusOK {
			status = http.StatusNoContent
		}
		WriteJSON(w, status, out)
	})
}

func (rt *Router) authenticate(r *http.Request) (*Actor, error) {
	for _, a := range rt.auth {
		actor, err := a.Authenticate(r)
		if err != nil {
			return nil, err
		}
		if actor != nil {
			return actor, nil
		}
	}
	return nil, ErrMissingCredentials
}

// WriteJSON writes v as a JSON response.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	if status == http.StatusNoContent {
		w.WriteHeader(status)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

// WriteError writes e in the error envelope.
func WriteError(w http.ResponseWriter, e *Error) {
	WriteJSON(w, e.Status, ErrorBody{Error: e})
}
