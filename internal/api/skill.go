package api

import (
	"embed"
	"fmt"
	"io/fs"
	"net/http"
	"reflect"
	"slices"
	"strings"
)

//go:embed skill/*.md
var skillFiles embed.FS

type Section func() string

func (rt *Router) AddDocs(version string, sections ...Section) {
	rt.Add(
		Route{
			Method: http.MethodGet, Path: "/skill.md", Tag: "Meta", Auth: AuthPublic,
			Summary:  "Read this skill: how to operate Iroha through its admin API",
			Response: "", ContentType: "text/markdown",
			Raw: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
				_, _ = w.Write([]byte(Skill(rt.Routes(), version, sections...)))
			}),
		},
		Route{
			Method: http.MethodGet, Path: "/api/openapi.json", Tag: "Meta", Auth: AuthPublic,
			Summary:  "Read the OpenAPI 3.1 description of every route",
			Response: map[string]any{},
			Raw: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				WriteJSON(w, http.StatusOK, OpenAPI(rt.Routes(), version))
			}),
		},
	)
}

func Skill(routes []Route, version string, sections ...Section) string {
	var b strings.Builder
	names, _ := fs.Glob(skillFiles, "skill/*.md")
	slices.Sort(names)
	for _, name := range names {
		body, _ := skillFiles.ReadFile(name)
		text := strings.ReplaceAll(string(body), "{{version}}", version)
		b.WriteString(strings.TrimRight(strings.ReplaceAll(text, "\r", ""), "\n"))
		b.WriteString("\n\n")
	}
	for _, s := range sections {
		b.WriteString(strings.TrimRight(s(), "\n"))
		b.WriteString("\n\n")
	}
	b.WriteString(routeReference(routes))
	return b.String()
}

func routeReference(routes []Route) string {
	var b strings.Builder
	b.WriteString("## Route reference\n\n")
	b.WriteString("Generated from the route table; `GET /api/openapi.json` has full schemas.\n")
	var tags []string
	byTag := map[string][]Route{}
	for _, r := range routes {
		if r.Hidden {
			continue
		}
		t := tagOf(r)
		if _, ok := byTag[t]; !ok {
			tags = append(tags, t)
		}
		byTag[t] = append(byTag[t], r)
	}
	for _, t := range tags {
		fmt.Fprintf(&b, "\n### %s\n", t)
		for _, r := range byTag[t] {
			fmt.Fprintf(&b, "\n#### `%s %s`\n\n%s. Auth: %s.\n", r.Method, r.DocPath(), strings.TrimSuffix(r.Summary, "."), r.Auth)
			if r.Description != "" {
				fmt.Fprintf(&b, "\n%s\n", strings.TrimSpace(r.Description))
			}
			if len(r.Query) > 0 {
				b.WriteString("\nQuery parameters:\n")
				for _, p := range r.Query {
					req := ""
					if p.Required {
						req = ", required"
					}
					enum := ""
					if len(p.Enum) > 0 {
						enum = " One of: " + strings.Join(p.Enum, ", ") + "."
					}
					fmt.Fprintf(&b, "- `%s` (%s%s): %s%s\n", p.Name, paramType(p), req, p.Description, enum)
				}
			}
			if r.Request != nil {
				if fields := bodyFields(r.Request); fields != "" {
					b.WriteString("\nBody fields:\n" + fields)
				}
			}
		}
	}
	return b.String()
}

func bodyFields(v any) string {
	t := reflect.TypeOf(v)
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	if t.Kind() != reflect.Struct {
		return ""
	}
	g := newSchemaGen()
	s := g.structSchema(t)
	props, _ := s["properties"].(map[string]any)
	required, _ := s["required"].([]string)
	var names []string
	for n := range props {
		names = append(names, n)
	}
	slices.Sort(names)
	var b strings.Builder
	for _, n := range names {
		p, _ := props[n].(map[string]any)
		typ, _ := p["type"].(string)
		if typ == "" {
			typ = "object"
		}
		req := ""
		if slices.Contains(required, n) {
			req = ", required"
		}
		desc, _ := p["description"].(string)
		fmt.Fprintf(&b, "- `%s` (%s%s)", n, typ, req)
		if desc != "" {
			b.WriteString(": " + desc)
		}
		b.WriteString("\n")
	}
	return b.String()
}
