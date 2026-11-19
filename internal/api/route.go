// Package api is Iroha's HTTP route table. Every route is a Route value; the
// Router registers its handler and generates /api/openapi.json and
// /skill.md from the same values, so the documents cannot drift from what
// is served.
package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
)

// Auth says who may call a route.
type Auth int

const (
	// AuthAdmin requires an Admin Token or Owner session. The default for /api/ routes.
	AuthAdmin Auth = iota
	// AuthPublic needs no credentials (health, documents, login).
	AuthPublic
	// AuthCaller is a Gateway route authenticated by a Gateway Key, which
	// the handler checks itself.
	AuthCaller
)

func (a Auth) String() string {
	switch a {
	case AuthPublic:
		return "public"
	case AuthCaller:
		return "Gateway Key"
	default:
		return "Admin Token"
	}
}

// Param documents a query parameter.
type Param struct {
	Name        string
	Type        string // "string" (default), "integer", "boolean", "number"
	Description string
	Required    bool
	Enum        []string
}

// Route is one entry of the route table.
type Route struct {
	Method string // GET, POST, PUT, PATCH, DELETE
	// Path is a net/http ServeMux path pattern, e.g. /api/admin-tokens/{name}.
	Path        string
	Summary     string // one line, imperative ("Read log events")
	Description string // optional; markdown; shown in the skill and OpenAPI
	Tag         string // resource group, e.g. "Logs"
	Auth        Auth
	Query       []Param
	// Request and Response are zero values of the body types (e.g.
	// CreateThing{} and Thing{}); their JSON Schemas are reflected from them.
	// Nil means no body. ContentType overrides application/json for the response.
	Request     any
	Response    any
	ContentType string
	Status      int // success status; default 200

	// Exactly one of Handle and Raw is set. Handle is for JSON routes; Raw for
	// anything else (streams, documents, static files).
	Handle func(c *Call) (any, error)
	Raw    http.Handler

	// Hidden routes are served but left out of the documents. Not allowed
	// under /api/ (the UI's static files use it).
	Hidden bool
}

// Pattern is the ServeMux pattern of the route.
func (r Route) Pattern() string { return r.Method + " " + r.Path }

var wildcard = regexp.MustCompile(`\{([^}]+)\}`)

// PathParams lists the {name} wildcards of the path, without "...".
func (r Route) PathParams() []string {
	var out []string
	for _, m := range wildcard.FindAllStringSubmatch(r.Path, -1) {
		name := strings.TrimSuffix(m[1], "...")
		if name != "$" {
			out = append(out, name)
		}
	}
	return out
}

// DocPath is the path as written in OpenAPI and the skill.
func (r Route) DocPath() string {
	p := strings.ReplaceAll(r.Path, "...}", "}")
	return strings.TrimSuffix(p, "{$}")
}

// Call is what a Handle function receives.
type Call struct {
	W      http.ResponseWriter
	R      *http.Request
	Actor  Actor // zero for public routes
	status int
}

// SetStatus overrides the success status for this call.
func (c *Call) SetStatus(code int) { c.status = code }

// Path returns a path wildcard's value.
func (c *Call) Path(name string) string { return c.R.PathValue(name) }

// Query returns a query parameter.
func (c *Call) Query(name string) string { return c.R.URL.Query().Get(name) }

// MaxBodyBytes caps admin request bodies.
const MaxBodyBytes = 16 << 20

// Decode reads the JSON body into v, refusing unknown fields so typos in
// field names are reported instead of ignored.
func (c *Call) Decode(v any) error {
	dec := json.NewDecoder(http.MaxBytesReader(c.W, c.R.Body, MaxBodyBytes))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		if errors.Is(err, io.EOF) {
			return BadRequest("Send a JSON object as the request body.", "The request body is empty.")
		}
		return BadRequest("Fix the JSON body; GET /api/openapi.json has the schema for this route.", "The request body is not valid: %v", err)
	}
	return nil
}
