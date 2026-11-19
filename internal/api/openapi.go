package api

import (
	"net/http"
	"strconv"
	"strings"
	"unicode"
)

// OpenAPI builds the OpenAPI 3.1 document for every non-hidden route.
func OpenAPI(routes []Route, version string) map[string]any {
	g := newSchemaGen()
	errRef := g.schemaOf(ErrorBody{})
	paths := map[string]any{}
	for _, r := range routes {
		if r.Hidden {
			continue
		}
		item, _ := paths[r.DocPath()].(map[string]any)
		if item == nil {
			item = map[string]any{}
			paths[r.DocPath()] = item
		}
		op := map[string]any{
			"operationId": OperationID(r),
			"summary":     r.Summary,
			"tags":        []string{tagOf(r)},
		}
		if r.Description != "" {
			op["description"] = r.Description
		}
		var params []any
		for _, name := range r.PathParams() {
			params = append(params, map[string]any{"name": name, "in": "path", "required": true, "schema": map[string]any{"type": "string"}})
		}
		for _, p := range r.Query {
			s := map[string]any{"type": paramType(p)}
			if len(p.Enum) > 0 {
				s["enum"] = p.Enum
			}
			q := map[string]any{"name": p.Name, "in": "query", "schema": s}
			if p.Description != "" {
				q["description"] = p.Description
			}
			if p.Required {
				q["required"] = true
			}
			params = append(params, q)
		}
		if len(params) > 0 {
			op["parameters"] = params
		}
		if r.Request != nil {
			op["requestBody"] = map[string]any{
				"required": true,
				"content":  map[string]any{"application/json": map[string]any{"schema": g.schemaOf(r.Request)}},
			}
		}
		status := r.Status
		if status == 0 {
			status = http.StatusOK
		}
		ok := map[string]any{"description": http.StatusText(status)}
		if r.Response != nil {
			ct := r.ContentType
			if ct == "" {
				ct = "application/json"
			}
			var schema map[string]any
			if ct == "application/json" {
				schema = g.schemaOf(r.Response)
			} else {
				schema = map[string]any{"type": "string"}
			}
			ok["content"] = map[string]any{ct: map[string]any{"schema": schema}}
		}
		op["responses"] = map[string]any{
			strconv.Itoa(status): ok,
			"default": map[string]any{
				"description": "Error. The hint says what to do next.",
				"content":     map[string]any{"application/json": map[string]any{"schema": errRef}},
			},
		}
		switch r.Auth {
		case AuthAdmin:
			op["security"] = []any{map[string]any{"adminToken": []string{}}}
		case AuthCaller:
			op["security"] = []any{map[string]any{"gatewayKey": []string{}}}
		}
		item[strings.ToLower(r.Method)] = op
	}
	return map[string]any{
		"openapi": "3.1.0",
		"info": map[string]any{
			"title":       "Iroha",
			"version":     version,
			"description": openAPIIntro,
		},
		"paths": paths,
		"components": map[string]any{
			"schemas": g.components,
			"securitySchemes": map[string]any{
				"adminToken": map[string]any{"type": "http", "scheme": "bearer", "description": "Admin Token"},
				"gatewayKey": map[string]any{"type": "http", "scheme": "bearer", "description": "Gateway Key"},
			},
		},
	}
}

// openAPIIntro states the admin API conventions once for every resource;
// the skill's "Conventions of every admin resource" section says the same
// at length.
const openAPIIntro = `Iroha's HTTP API. Admin routes live under /api/ and take an Admin Token (or the Owner's session); GET /skill.md explains how to use them.

Conventions shared by every admin resource:
- Addressing: a {path} parameter naming a record accepts its name (or handle) or its ID.
- Dry run: every mutating route (POST, PUT, PATCH, DELETE) accepts ?dry_run=true. It runs the change, reports exactly what would change in "changes", and writes nothing.
- Create-or-update: POST /api/<resource> with the name of an existing record updates it instead of making a duplicate; "outcome" says created (201), updated or unchanged (200).
- Bulk: POST /api/<resource>/bulk (and /bulk/<action>) takes {"items": [...]}, applies every item that succeeds and reports each one in "items" (ok, outcome, result or error). One failing item does not stop the others.
- Audit: every mutation that changes something writes one Audit Entry (actor, before, after), returned as "audit_entry"; POST /api/audit-entries/{entry}/revert restores the before-state and is itself audited.
- Errors: {"error": {"code", "message", "hint", "details"}}. The hint always names the next action.`

// OperationID derives a stable operation id, e.g. GET /api/logs -> getLogs,
// POST /api/admin-tokens/{name}/revoke -> postAdminTokensNameRevoke.
func OperationID(r Route) string {
	var b strings.Builder
	b.WriteString(strings.ToLower(r.Method))
	upper := true
	for _, c := range strings.TrimPrefix(r.DocPath(), "/api") {
		if unicode.IsLetter(c) || unicode.IsDigit(c) {
			if upper {
				c = unicode.ToUpper(c)
				upper = false
			}
			b.WriteRune(c)
		} else {
			upper = true
		}
	}
	return b.String()
}

func tagOf(r Route) string {
	if r.Tag != "" {
		return r.Tag
	}
	return "Other"
}

func paramType(p Param) string {
	if p.Type == "" {
		return "string"
	}
	return p.Type
}
