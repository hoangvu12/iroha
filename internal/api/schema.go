package api

import (
	"encoding/json"
	"reflect"
	"regexp"
	"strings"
	"time"
)

// Schema reflection turns Go body types into JSON Schema (OpenAPI 3.1).
// Field rules: the json tag names the field ("-" skips it); omitempty makes
// it optional, otherwise it is required; a `doc:"..."` tag describes it; an
// `enum:"a,b"` tag lists allowed values. Named structs become components.

type schemaGen struct {
	components map[string]any
	names      map[reflect.Type]string
	taken      map[string]reflect.Type
}

func newSchemaGen() *schemaGen {
	return &schemaGen{components: map[string]any{}, names: map[reflect.Type]string{}, taken: map[string]reflect.Type{}}
}

var (
	timeType       = reflect.TypeFor[time.Time]()
	rawMessageType = reflect.TypeFor[json.RawMessage]()
	nonNameChars   = regexp.MustCompile(`[^A-Za-z0-9_.-]+`)
)

func (g *schemaGen) schemaOf(v any) map[string]any {
	if v == nil {
		return nil
	}
	return g.of(reflect.TypeOf(v))
}

func (g *schemaGen) of(t reflect.Type) map[string]any {
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	switch t {
	case timeType:
		return map[string]any{"type": "string", "format": "date-time"}
	case rawMessageType:
		return map[string]any{}
	}
	switch t.Kind() {
	case reflect.String:
		return map[string]any{"type": "string"}
	case reflect.Bool:
		return map[string]any{"type": "boolean"}
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return map[string]any{"type": "integer"}
	case reflect.Float32, reflect.Float64:
		return map[string]any{"type": "number"}
	case reflect.Slice, reflect.Array:
		if t.Elem().Kind() == reflect.Uint8 {
			return map[string]any{"type": "string", "contentEncoding": "base64"}
		}
		return map[string]any{"type": "array", "items": g.of(t.Elem())}
	case reflect.Map:
		return map[string]any{"type": "object", "additionalProperties": g.of(t.Elem())}
	case reflect.Struct:
		if t.Name() == "" {
			return g.structSchema(t)
		}
		return map[string]any{"$ref": "#/components/schemas/" + g.component(t)}
	default: // interfaces and anything else: any JSON value
		return map[string]any{}
	}
}

func (g *schemaGen) component(t reflect.Type) string {
	if name, ok := g.names[t]; ok {
		return name
	}
	name := nonNameChars.ReplaceAllString(t.Name(), "_")
	if other, ok := g.taken[name]; ok && other != t {
		pkg := t.PkgPath()
		name = nonNameChars.ReplaceAllString(pkg[strings.LastIndex(pkg, "/")+1:]+"."+t.Name(), "_")
	}
	g.names[t] = name
	g.taken[name] = t
	g.components[name] = map[string]any{} // placeholder for recursion
	g.components[name] = g.structSchema(t)
	return name
}

func (g *schemaGen) structSchema(t reflect.Type) map[string]any {
	props := map[string]any{}
	var required []string
	var walk func(t reflect.Type)
	walk = func(t reflect.Type) {
		for i := range t.NumField() {
			f := t.Field(i)
			tag := f.Tag.Get("json")
			if tag == "-" {
				continue
			}
			name, opts, _ := strings.Cut(tag, ",")
			if f.Anonymous && name == "" {
				ft := f.Type
				if ft.Kind() == reflect.Pointer {
					ft = ft.Elem()
				}
				if ft.Kind() == reflect.Struct {
					walk(ft)
					continue
				}
			}
			if !f.IsExported() {
				continue
			}
			if name == "" {
				name = f.Name
			}
			s := g.of(f.Type)
			if doc := f.Tag.Get("doc"); doc != "" || f.Tag.Get("enum") != "" {
				s = clone(s)
				if doc != "" {
					s["description"] = doc
				}
				if enum := f.Tag.Get("enum"); enum != "" {
					s["enum"] = strings.Split(enum, ",")
				}
			}
			props[name] = s
			if !strings.Contains(opts, "omitempty") && !strings.Contains(opts, "omitzero") && f.Type.Kind() != reflect.Pointer {
				required = append(required, name)
			}
		}
	}
	walk(t)
	out := map[string]any{"type": "object", "properties": props}
	if len(required) > 0 {
		out["required"] = required
	}
	return out
}

func clone(m map[string]any) map[string]any {
	c := make(map[string]any, len(m)+2)
	for k, v := range m {
		c[k] = v
	}
	return c
}
