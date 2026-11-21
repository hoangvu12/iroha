package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
)

type Auth int

const (
	AuthAdmin Auth = iota
	AuthPublic
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

type Param struct {
	Name        string
	Type        string
	Description string
	Required    bool
	Enum        []string
}

type Route struct {
	Method      string
	Path        string
	Summary     string
	Description string
	Tag         string
	Auth        Auth
	Query       []Param
	Request     any
	Response    any
	ContentType string
	Status      int

	Handle func(c *Call) (any, error)
	Raw    http.Handler

	Hidden bool
}

func (r Route) Pattern() string { return r.Method + " " + r.Path }

var wildcard = regexp.MustCompile(`\{([^}]+)\}`)

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

func (r Route) DocPath() string {
	p := strings.ReplaceAll(r.Path, "...}", "}")
	return strings.TrimSuffix(p, "{$}")
}

type Call struct {
	W      http.ResponseWriter
	R      *http.Request
	Actor  Actor
	status int
}

func (c *Call) SetStatus(code int) { c.status = code }

func (c *Call) Path(name string) string { return c.R.PathValue(name) }

func (c *Call) Query(name string) string { return c.R.URL.Query().Get(name) }

const MaxBodyBytes = 16 << 20

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
