package translate_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/hoangvu12/iroha/internal/shape"
	"github.com/hoangvu12/iroha/internal/translate"
)

const schemaJSON = `{"type":"object","properties":{"reasoning":{"type":"string"},"answer":{"type":"string"}},"required":["reasoning","answer"],"additionalProperties":false}`

var structuredRequests = map[shape.Shape]string{
	shape.OpenAIChat: `{"model":"m","messages":[{"role":"user","content":"hi"}],
		"response_format":{"type":"json_schema","json_schema":{"name":"verdict","description":"A verdict","strict":true,"schema":` + schemaJSON + `}}}`,
	shape.AnthropicMessages: `{"model":"m","max_tokens":10,"messages":[{"role":"user","content":"hi"}],
		"output_config":{"format":{"type":"json_schema","schema":` + schemaJSON + `}}}`,
	shape.OpenAIResponses: `{"model":"m","input":"hi",
		"text":{"format":{"type":"json_schema","name":"verdict","description":"A verdict","strict":true,"schema":` + schemaJSON + `}}}`,
	shape.Gemini: `{"contents":[{"role":"user","parts":[{"text":"hi"}]}],
		"generationConfig":{"responseMimeType":"application/json","responseJsonSchema":` + schemaJSON + `}}`,
}

func rawRequest(t *testing.T, from, to shape.Shape, req string) (string, *translate.Translation) {
	t.Helper()
	tr, err := translate.New(from, to, translate.Options{Model: "m", ID: "req_1", Now: now})
	if err != nil {
		t.Fatal(err)
	}
	out, err := tr.Request(context.Background(), []byte(req), "w")
	if err != nil {
		t.Fatalf("%s -> %s: %v", from, to, err)
	}
	return string(out), tr
}

func sentSchema(t *testing.T, to shape.Shape, sent string) (format map[string]json.RawMessage, schema string) {
	t.Helper()
	var req map[string]json.RawMessage
	if err := json.Unmarshal([]byte(sent), &req); err != nil {
		t.Fatal(err)
	}
	member := func(raw json.RawMessage, key string) json.RawMessage {
		var m map[string]json.RawMessage
		_ = json.Unmarshal(raw, &m)
		return m[key]
	}
	var f json.RawMessage
	switch to {
	case shape.OpenAIChat:
		f = req["response_format"]
		_ = json.Unmarshal(f, &format)
		return format, string(member(format["json_schema"], "schema"))
	case shape.AnthropicMessages:
		f = member(req["output_config"], "format")
	case shape.OpenAIResponses:
		f = member(req["text"], "format")
	case shape.Gemini:
		_ = json.Unmarshal(req["generationConfig"], &format)
		s := format["responseJsonSchema"]
		if s == nil {
			s = format["responseSchema"]
		}
		return format, string(s)
	}
	_ = json.Unmarshal(f, &format)
	return format, string(format["schema"])
}

func TestAJSONSchemaReachesEveryShape(t *testing.T) {
	for from, req := range structuredRequests {
		for _, to := range translate.Targets(from) {
			sent, _ := rawRequest(t, from, to, req)
			format, schema := sentSchema(t, to, sent)
			if format == nil || schema == "" {
				t.Errorf("%s -> %s: no schema sent:\n%s", from, to, sent)
				continue
			}
			if !strings.Contains(schema, `"reasoning"`) || !strings.Contains(schema, `"answer"`) {
				t.Errorf("%s -> %s: schema = %s", from, to, schema)
			}
			if to != shape.Gemini && strings.Index(schema, `"reasoning"`) > strings.Index(schema, `"answer"`) {
				t.Errorf("%s -> %s: properties reordered: %s", from, to, schema)
			}
			switch to {
			case shape.OpenAIChat:
				var js map[string]any
				_ = json.Unmarshal(format["json_schema"], &js)
				if string(format["type"]) != `"json_schema"` || js["name"] == "" || js["name"] == nil {
					t.Errorf("%s -> Chat: response_format = %s (OpenAI requires json_schema.name)", from, sent)
				}
			case shape.OpenAIResponses:
				if string(format["type"]) != `"json_schema"` || format["name"] == nil {
					t.Errorf("%s -> Responses: text.format = %v", from, format)
				}
			case shape.AnthropicMessages:
				if string(format["type"]) != `"json_schema"` || len(format) != 2 {
					t.Errorf("%s -> Anthropic: output_config.format = %s", from, sent)
				}
			case shape.Gemini:
				if string(format["responseMimeType"]) != `"application/json"` {
					t.Errorf("%s -> Gemini: generationConfig = %s", from, sent)
				}
			}
		}
	}
}

func TestSchemaNamesCarryOverOrAreMade(t *testing.T) {
	sent, _ := rawRequest(t, shape.OpenAIResponses, shape.OpenAIChat, structuredRequests[shape.OpenAIResponses])
	format, _ := sentSchema(t, shape.OpenAIChat, sent)
	var js map[string]any
	_ = json.Unmarshal(format["json_schema"], &js)
	if js["name"] != "verdict" || js["description"] != "A verdict" || js["strict"] != true {
		t.Errorf("Responses -> Chat json_schema = %v", js)
	}
	sent, _ = rawRequest(t, shape.AnthropicMessages, shape.OpenAIResponses, structuredRequests[shape.AnthropicMessages])
	if format, _ = sentSchema(t, shape.OpenAIResponses, sent); string(format["name"]) != `"response"` || format["strict"] != nil {
		t.Errorf("Anthropic -> Responses text.format = %v", format)
	}
}

func TestAnthropicLegacyOutputFormatAndEffortSideBySide(t *testing.T) {
	legacy := `{"model":"m","max_tokens":10,"messages":[{"role":"user","content":"hi"}],"output_format":{"type":"json_schema","schema":` + schemaJSON + `}}`
	sent, _ := rawRequest(t, shape.AnthropicMessages, shape.OpenAIChat, legacy)
	if _, schema := sentSchema(t, shape.OpenAIChat, sent); !strings.Contains(schema, `"reasoning"`) {
		t.Errorf("output_format -> Chat: %s", sent)
	}
	withEffort := `{"model":"m","messages":[{"role":"user","content":"hi"}],"reasoning_effort":"low",
		"response_format":{"type":"json_schema","json_schema":{"name":"v","schema":` + schemaJSON + `}}}`
	sent, _ = rawRequest(t, shape.OpenAIChat, shape.AnthropicMessages, withEffort)
	if _, schema := sentSchema(t, shape.AnthropicMessages, sent); schema == "" {
		t.Errorf("Chat with effort -> Anthropic lost the format: %s", sent)
	}
}

func TestJSONModeWithoutASchema(t *testing.T) {
	jsonMode := map[shape.Shape]string{
		shape.OpenAIChat:      `{"model":"m","messages":[{"role":"user","content":"reply in JSON"}],"response_format":{"type":"json_object"}}`,
		shape.OpenAIResponses: `{"model":"m","input":"reply in JSON","text":{"format":{"type":"json_object"}}}`,
		shape.Gemini:          `{"contents":[{"role":"user","parts":[{"text":"reply in JSON"}]}],"generationConfig":{"responseMimeType":"application/json"}}`,
	}
	for from, req := range jsonMode {
		for _, to := range translate.Targets(from) {
			sent, tr := rawRequest(t, from, to, req)
			format, schema := sentSchema(t, to, sent)
			if schema != "" {
				t.Errorf("%s -> %s: JSON mode sent a schema: %s", from, to, sent)
			}
			switch to {
			case shape.AnthropicMessages:
				if strings.Contains(sent, "output_config") || !strings.Contains(strings.Join(tr.Diagnostics, "\n"), "unsupported_response_format") {
					t.Errorf("%s -> Anthropic: %s, diagnostics %q", from, sent, tr.Diagnostics)
				}
			case shape.Gemini:
				if string(format["responseMimeType"]) != `"application/json"` {
					t.Errorf("%s -> Gemini: %s", from, sent)
				}
			default:
				if string(format["type"]) != `"json_object"` {
					t.Errorf("%s -> %s: %s", from, to, sent)
				}
			}
		}
	}
}

func TestSchemaKeywordsAnthropicCannotTakeMoveIntoTheDescription(t *testing.T) {
	req := `{"model":"m","messages":[{"role":"user","content":"hi"}],"response_format":{"type":"json_schema","json_schema":{"name":"v","schema":
		{"type":"object","properties":{
			"name":{"type":"string","description":"Full name","minLength":2,"maxLength":40},
			"age":{"type":"integer","minimum":0},
			"when":{"type":"string","format":"date-time"},
			"tags":{"type":"array","items":{"type":"string","format":"color"},"minItems":1,"maxItems":5},
			"pet":{"oneOf":[{"type":"object","properties":{"kind":{"type":"string","enum":["cat","dog"]}}},{"type":"null"}]}},
		"required":["name"],"additionalProperties":true}}}}`
	sent, tr := rawRequest(t, shape.OpenAIChat, shape.AnthropicMessages, req)
	_, schema := sentSchema(t, shape.AnthropicMessages, sent)
	var s map[string]any
	if err := json.Unmarshal([]byte(schema), &s); err != nil {
		t.Fatalf("schema %s: %v", schema, err)
	}
	props := confObj(s["properties"])
	name, age, when, tags := confObj(props["name"]), confObj(props["age"]), confObj(props["when"]), confObj(props["tags"])
	if name["minLength"] != nil || name["description"] != "Full name\n\n{minLength: 2, maxLength: 40}" {
		t.Errorf("name = %v", name)
	}
	if age["minimum"] != nil || age["description"] != "{minimum: 0}" {
		t.Errorf("age = %v", age)
	}
	if when["format"] != "date-time" || when["description"] != nil {
		t.Errorf("a supported format must stay: %v", when)
	}
	if tags["minItems"] != float64(1) || tags["maxItems"] != nil || tags["description"] != "{maxItems: 5}" ||
		confObj(tags["items"])["format"] != nil || confObj(tags["items"])["description"] != `{format: "color"}` {
		t.Errorf("tags = %v", tags)
	}
	pet := confObj(props["pet"])
	alts := confList(pet["anyOf"])
	if pet["oneOf"] != nil || len(alts) != 2 || confObj(alts[0])["additionalProperties"] != false {
		t.Errorf("pet = %v", pet)
	}
	if s["additionalProperties"] != false || s["required"] == nil {
		t.Errorf("root = %v", s)
	}
	if strings.Index(schema, `"name"`) > strings.Index(schema, `"age"`) {
		t.Errorf("properties reordered: %s", schema)
	}
	if !strings.Contains(strings.Join(tr.Diagnostics, "\n"), "schema_keyword_moved") {
		t.Errorf("diagnostics = %q", tr.Diagnostics)
	}
}

func TestGeminiResponseSchemaBecomesJSONSchema(t *testing.T) {
	req := `{"contents":[{"role":"user","parts":[{"text":"hi"}]}],"generationConfig":{"responseMimeType":"application/json","responseSchema":
		{"type":"OBJECT","properties":{"answer":{"type":"STRING","nullable":true},"reasoning":{"type":"STRING"}},"propertyOrdering":["reasoning","answer"]}}}`
	sent, _ := rawRequest(t, shape.Gemini, shape.OpenAIChat, req)
	_, schema := sentSchema(t, shape.OpenAIChat, sent)
	want := `{"properties":{"reasoning":{"type":"string"},"answer":{"type":["string","null"]}},"type":"object"}`
	if schema != want {
		t.Errorf("schema = %s, want %s", schema, want)
	}
}

func TestSearchResultBlocksBecomeText(t *testing.T) {
	sr := `{"type":"search_result","source":"https://example.com/doc","title":"Doc","content":[{"type":"text","text":"Fact one."},{"type":"text","text":"Fact two."}],"citations":{"enabled":true}}`
	req := `{"model":"m","max_tokens":10,"tools":[{"name":"kb","input_schema":{"type":"object"}}],"output_config":{"format":{"type":"json_schema","schema":` + schemaJSON + `}},"messages":[
		{"role":"user","content":[` + sr + `,{"type":"text","text":"What does it say?"}]},
		{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"kb","input":{}}]},
		{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":[` + sr + `]}]}]}`
	text := "Search result: Doc\nSource: https://example.com/doc\n\nFact one.\n\nFact two."
	for _, to := range translate.Targets(shape.AnthropicMessages) {
		sent, _ := rawRequest(t, shape.AnthropicMessages, to, req)
		if strings.Contains(sent, "search_result") || strings.Count(sent, "Fact two.") != 2 {
			t.Errorf("-> %s: %s", to, sent)
		}
		if _, schema := sentSchema(t, to, sent); to != shape.Gemini && strings.Index(schema, `"reasoning"`) > strings.Index(schema, `"answer"`) {
			t.Errorf("-> %s: rewriting the messages reordered the schema: %s", to, schema)
		}
	}
	sent, _ := confRequest(t, shape.AnthropicMessages, shape.OpenAIChat, req)
	msgs := confList(sent["messages"])
	if len(msgs) != 3 {
		t.Fatalf("messages = %v", msgs)
	}
	first := confList(confObj(msgs[0])["content"])
	if len(first) != 2 || confObj(first[0])["text"] != text || confObj(first[1])["text"] != "What does it say?" {
		t.Errorf("user message = %v", msgs[0])
	}
	if tool := confObj(msgs[2]); tool["role"] != "tool" || tool["tool_call_id"] != "toolu_1" || tool["content"] != text {
		t.Errorf("tool message = %v", tool)
	}
}
