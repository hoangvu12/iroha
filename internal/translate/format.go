package translate

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"sort"
	"strings"

	"github.com/QuantumNous/new-api/relaykit/dto"
)

// RelayKit drops a JSON schema to and from Anthropic and from Gemini, and
// loses its property order through a map, while models fill properties in
// schema order. So each codec reads and writes structured output itself.

type outputMode int

const (
	anyJSON outputMode = iota
	matchingSchema
)

type outputFormat struct {
	mode        outputMode
	schema      json.RawMessage
	name        string
	description string
	strict      json.RawMessage
}

// OpenAI requires a schema name.
const defaultSchemaName = "response"

func readOpenAIFormat(typ string, raw json.RawMessage) *outputFormat {
	switch typ {
	case "json_object":
		return &outputFormat{mode: anyJSON}
	case "json_schema":
	default:
		return nil
	}
	var m struct {
		Name        string          `json:"name"`
		Description string          `json:"description"`
		Schema      json.RawMessage `json:"schema"`
		Strict      json.RawMessage `json:"strict"`
	}
	if json.Unmarshal(raw, &m) != nil || !present(m.Schema) {
		return &outputFormat{mode: anyJSON}
	}
	f := &outputFormat{mode: matchingSchema, schema: m.Schema, name: m.Name, description: m.Description}
	if present(m.Strict) {
		f.strict = m.Strict
	}
	return f
}

func present(raw json.RawMessage) bool {
	return len(raw) > 0 && string(raw) != "null"
}

func (f *outputFormat) openAIFormat(withType bool) object {
	var o object
	if withType {
		o = o.set("type", "json_schema")
	}
	name := f.name
	if name == "" {
		name = defaultSchemaName
	}
	o = o.set("name", name)
	if f.description != "" {
		o = o.set("description", f.description)
	}
	o = o.set("schema", f.schema)
	if f.strict != nil {
		o = o.set("strict", f.strict)
	}
	return o
}

func readChatFormat(req any) *outputFormat {
	rf := req.(*dto.GeneralOpenAIRequest).ResponseFormat
	if rf == nil {
		return nil
	}
	return readOpenAIFormat(rf.Type, rf.JsonSchema)
}

func readResponsesFormat(req any) *outputFormat {
	var text struct {
		Format json.RawMessage `json:"format"`
	}
	if json.Unmarshal(req.(*dto.OpenAIResponsesRequest).Text, &text) != nil {
		return nil
	}
	var typ struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(text.Format, &typ) != nil {
		return nil
	}
	return readOpenAIFormat(typ.Type, text.Format)
}

func readAnthropicFormat(req any) *outputFormat {
	r := req.(*dto.ClaudeRequest)
	var oc struct {
		Format json.RawMessage `json:"format"`
	}
	raw := r.OutputFormat
	if json.Unmarshal(r.OutputConfig, &oc) == nil && present(oc.Format) {
		raw = oc.Format
	}
	var f struct {
		Type   string          `json:"type"`
		Schema json.RawMessage `json:"schema"`
	}
	if json.Unmarshal(raw, &f) != nil || f.Type != "json_schema" || !present(f.Schema) {
		return nil
	}
	return &outputFormat{mode: matchingSchema, schema: f.Schema}
}

func readGeminiFormat(req any) *outputFormat {
	gc := req.(*dto.GeminiChatRequest).GenerationConfig
	if gc.ResponseMimeType != "application/json" {
		return nil
	}
	if present(gc.ResponseJsonSchema) {
		return &outputFormat{mode: matchingSchema, schema: gc.ResponseJsonSchema}
	}
	if gc.ResponseSchema != nil {
		if b, err := marshal(openAPISchema(gc.ResponseSchema)); err == nil {
			return &outputFormat{mode: matchingSchema, schema: b}
		}
	}
	return &outputFormat{mode: anyJSON}
}

// A Gemini Schema is an OpenAPI 3.0 subset (upper-case types, nullable,
// propertyOrdering). RelayKit decoded it into a map, so keys other than
// the ordered properties come out sorted.
func openAPISchema(v any) any {
	switch v := v.(type) {
	case []any:
		out := make([]any, len(v))
		for i, x := range v {
			out[i] = openAPISchema(x)
		}
		return out
	case map[string]any:
		keys := make([]string, 0, len(v))
		for k := range v {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		var o object
		for _, k := range keys {
			val := v[k]
			switch k {
			case "propertyOrdering", "nullable":
				continue
			case "type":
				t := strings.ToLower(str(val))
				if v["nullable"] == true {
					o = o.set(k, []any{t, "null"})
				} else {
					o = o.set(k, t)
				}
			case "properties":
				o = o.set(k, orderedProperties(obj(val), list(v["propertyOrdering"])))
			default:
				o = o.set(k, openAPISchema(val))
			}
		}
		return o
	}
	return v
}

func orderedProperties(props map[string]any, order []any) object {
	var keys []string
	for _, k := range order {
		if _, ok := props[str(k)]; ok && !slices.Contains(keys, str(k)) {
			keys = append(keys, str(k))
		}
	}
	var rest []string
	for k := range props {
		if !slices.Contains(keys, k) {
			rest = append(rest, k)
		}
	}
	sort.Strings(rest)
	var o object
	for _, k := range append(keys, rest...) {
		o = o.set(k, openAPISchema(props[k]))
	}
	return o
}

func writeChatFormat(req map[string]any, f *outputFormat, _ *Translation) {
	if f.mode == anyJSON {
		req["response_format"] = map[string]any{"type": "json_object"}
		return
	}
	req["response_format"] = object{}.set("type", "json_schema").set("json_schema", f.openAIFormat(false))
}

func writeResponsesFormat(req map[string]any, f *outputFormat, _ *Translation) {
	text := obj(req["text"])
	if text == nil {
		text = map[string]any{}
	}
	if f.mode == anyJSON {
		text["format"] = map[string]any{"type": "json_object"}
	} else {
		text["format"] = f.openAIFormat(true)
	}
	req["text"] = text
}

func writeAnthropicFormat(req map[string]any, f *outputFormat, t *Translation) {
	delete(req, "output_format")
	if f.mode == anyJSON {
		t.Diagnostics = append(t.Diagnostics, "unsupported_response_format: Anthropic has no JSON mode without a schema; it was dropped")
		return
	}
	schema, err := decodeOrdered(f.schema)
	if err != nil {
		return
	}
	var moved []string
	schema = anthropicSchema(schema, &moved)
	if len(moved) > 0 {
		t.Diagnostics = append(t.Diagnostics, "schema_keyword_moved: Anthropic cannot take "+strings.Join(moved, ", ")+
			" in a response schema; moved into descriptions")
	}
	oc := obj(req["output_config"])
	if oc == nil {
		oc = map[string]any{}
	}
	oc["format"] = object{}.set("type", "json_schema").set("schema", schema)
	req["output_config"] = oc
}

func writeGeminiFormat(req map[string]any, f *outputFormat, _ *Translation) {
	gc := obj(req["generationConfig"])
	if gc == nil {
		gc = map[string]any{}
	}
	gc["responseMimeType"] = "application/json"
	if f.mode == matchingSchema && gc["responseSchema"] == nil && gc["responseJsonSchema"] == nil {
		gc["responseJsonSchema"] = f.schema
	}
	req["generationConfig"] = gc
}

var anthropicStringFormats = map[string]bool{"date-time": true, "time": true, "date": true, "duration": true, "email": true,
	"hostname": true, "uri": true, "ipv4": true, "ipv6": true, "uuid": true}

// Anthropic takes a subset of JSON Schema. As in Anthropic's SDKs, oneOf
// becomes anyOf, every object gets additionalProperties false, and other
// keywords move into the description.
func anthropicSchema(v any, moved *[]string) any {
	o, ok := v.(object)
	if !ok {
		return v
	}
	var out, rest object
	isObject := false
	for _, m := range o {
		switch m.key {
		case "type":
			isObject = isObject || m.val == "object" || slices.Contains(listOf(m.val), any("object"))
			out = append(out, m)
		case "properties", "$defs", "definitions":
			isObject = isObject || m.key == "properties"
			sub, _ := m.val.(object)
			var props object
			for _, p := range sub {
				props = append(props, member{p.key, anthropicSchema(p.val, moved)})
			}
			out = append(out, member{m.key, props})
		case "items":
			if _, ok := m.val.(object); ok {
				out = append(out, member{m.key, anthropicSchema(m.val, moved)})
			} else {
				rest = append(rest, m)
			}
		case "anyOf", "allOf", "oneOf":
			key := m.key
			if key == "oneOf" {
				key = "anyOf"
			}
			var alts []any
			for _, a := range listOf(m.val) {
				alts = append(alts, anthropicSchema(a, moved))
			}
			out = append(out, member{key, alts})
		case "additionalProperties":
			// Written below: Anthropic takes only false.
		case "$ref", "required", "enum", "const", "default", "description", "title", "pattern":
			out = append(out, m)
		case "format":
			if anthropicStringFormats[str(m.val)] {
				out = append(out, m)
			} else {
				rest = append(rest, m)
			}
		case "minItems":
			if n, ok := m.val.(json.Number); ok && (n == "0" || n == "1") {
				out = append(out, m)
			} else {
				rest = append(rest, m)
			}
		default:
			rest = append(rest, m)
		}
	}
	if isObject {
		out = out.set("additionalProperties", false)
	}
	if len(rest) > 0 {
		var notes []string
		for _, m := range rest {
			b, _ := marshal(m.val)
			notes = append(notes, m.key+": "+string(b))
			*moved = append(*moved, m.key)
		}
		desc := "{" + strings.Join(notes, ", ") + "}"
		if d, ok := out.get("description"); ok && str(d) != "" {
			desc = str(d) + "\n\n" + desc
		}
		out = out.set("description", desc)
	}
	return out
}

func listOf(v any) []any { l, _ := v.([]any); return l }

type object []member

type member struct {
	key string
	val any
}

func (o object) get(key string) (any, bool) {
	for _, m := range o {
		if m.key == key {
			return m.val, true
		}
	}
	return nil, false
}

func (o object) set(key string, val any) object {
	for i, m := range o {
		if m.key == key {
			o[i].val = val
			return o
		}
	}
	return append(o, member{key, val})
}

func (o object) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, m := range o {
		if i > 0 {
			b.WriteByte(',')
		}
		k, err := marshal(m.key)
		if err != nil {
			return nil, err
		}
		v, err := marshal(m.val)
		if err != nil {
			return nil, err
		}
		b.Write(k)
		b.WriteByte(':')
		b.Write(v)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

func decodeOrdered(raw []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	v, err := decodeValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("trailing data after the JSON value")
	}
	return v, nil
}

func decodeValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	d, ok := tok.(json.Delim)
	if !ok {
		return tok, nil
	}
	switch d {
	case '{':
		o := object{}
		for dec.More() {
			kt, err := dec.Token()
			if err != nil {
				return nil, err
			}
			k, _ := kt.(string)
			v, err := decodeValue(dec)
			if err != nil {
				return nil, err
			}
			o = append(o, member{k, v})
		}
		_, err := dec.Token()
		return o, err
	case '[':
		l := []any{}
		for dec.More() {
			v, err := decodeValue(dec)
			if err != nil {
				return nil, err
			}
			l = append(l, v)
		}
		_, err := dec.Token()
		return l, err
	}
	return nil, fmt.Errorf("unexpected %v", d)
}
