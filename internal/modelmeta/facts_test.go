package modelmeta_test

import (
	"encoding/json"
	"testing"

	"github.com/hoangvu12/iroha/internal/modelmeta"
)

func n(v int64) *int64 { return &v }
func b(v bool) *bool   { return &v }

// js is a Facts as its JSON, for readable comparisons.
func js(f modelmeta.Facts) string {
	out, _ := json.Marshal(f)
	return string(out)
}

func TestNormalizeReadsCommonAliasesAndNestedShapes(t *testing.T) {
	cases := []struct {
		name, raw, want string
	}{
		{"nothing known", `{"id":"gpt-4o","object":"model","owned_by":"openai"}`, `{}`},
		{"not an object", `"gpt-4o"`, `{}`},
		{"flat aliases", `{"context_length":128000,"max_input_tokens":120000,"max_output_tokens":16384}`,
			`{"context_length":128000,"max_input_tokens":120000,"max_output_tokens":16384}`},
		{"context_window and max_completion_tokens", `{"context_window":"200000","max_completion_tokens":"64000"}`,
			`{"context_length":200000,"max_output_tokens":64000}`},
		{"llama.cpp n_ctx", `{"n_ctx":32768}`, `{"context_length":32768}`},
		{"Gemini token limits", `{"name":"models/gemini-2.5-pro","inputTokenLimit":1048576,"outputTokenLimit":65536,"supportedGenerationMethods":["generateContent","countTokens"]}`,
			`{"context_length":1048576,"max_input_tokens":1048576,"max_output_tokens":65536,"chat":"ok"}`},
		{"Gemini embedding model", `{"name":"models/text-embedding-004","supportedGenerationMethods":["embedContent"]}`, `{"chat":"unsupported"}`},
		{"OpenRouter nested", `{"id":"openai/gpt-4o","context_length":128000,"architecture":{"modality":"text+image->text","input_modalities":["text","image"],"output_modalities":["text"]},
			"top_provider":{"context_length":128000,"max_completion_tokens":16384},"supported_parameters":["tools","reasoning","include_reasoning"]}`,
			`{"context_length":128000,"max_output_tokens":16384,"architecture":{"input_modalities":["text","image"],"output_modalities":["text"]},"reasoning":true}`},
		{"OpenRouter modality string only", `{"architecture":{"modality":"Text+Image->Text"}}`,
			`{"architecture":{"input_modalities":["text","image"],"output_modalities":["text"]}}`},
		{"limit object, context from input", `{"limit":{"input":100000,"output":8000}}`,
			`{"context_length":100000,"max_input_tokens":100000,"max_output_tokens":8000}`},
		{"bad numbers ignored", `{"context_length":0,"context_window":-5,"max_context":1.5,"ctx_len":"lots","n_ctx":9007199254740993,"context_size":4096}`,
			`{"context_length":4096}`},
		{"modalities lower-cased and de-duplicated", `{"modalities":{"input":["Text"," IMAGE ","text",""],"output":["text"]}}`,
			`{"architecture":{"input_modalities":["text","image"],"output_modalities":["text"]}}`},
		{"models.dev reasoning levels", `{"reasoning":true,"reasoning_options":[{"type":"effort","values":["low","medium","high"]}]}`,
			`{"reasoning":true,"reasoning_levels":["low","medium","high"]}`},
		{"models.dev toggle", `{"reasoning":true,"reasoning_options":[{"type":"toggle"}]}`, `{"reasoning":true}`},
		{"levels alone mean reasoning", `{"reasoning_efforts":["minimal","low"]}`, `{"reasoning":true,"reasoning_levels":["minimal","low"]}`},
		{"no reasoning drops levels", `{"reasoning":false,"reasoning_levels":["low"]}`, `{"reasoning":false}`},
		{"capabilities.thinking object", `{"capabilities":{"thinking":{"supported":true}}}`, `{"reasoning":true}`},
		{"explicit chat word", `{"capabilities":{"completion_chat":"not supported"}}`, `{"chat":"unsupported"}`},
		{"explicit chat bool", `{"chat":true}`, `{"chat":"ok"}`},
		{"supported endpoints: responses only still chats through Iroha", `{"supported_endpoints":["/v1/responses"]}`, `{"chat":"ok"}`},
		{"supported endpoints: embeddings", `{"supported_endpoints":["/v1/embeddings"]}`, `{"chat":"unsupported"}`},
		{"audio in, text out, temperature: not chat", `{"modalities":{"input":["audio"],"output":["text"]},"temperature":true}`,
			`{"architecture":{"input_modalities":["audio"],"output_modalities":["text"]},"chat":"unsupported"}`},
		{"image output: not chat", `{"output_modalities":["image"]}`, `{"architecture":{"output_modalities":["image"]},"chat":"unsupported"}`},
		{"text with tool calls: chat", `{"modalities":{"input":["text"],"output":["text"]},"tool_call":true}`,
			`{"architecture":{"input_modalities":["text"],"output_modalities":["text"]},"chat":"ok"}`},
		{"text without evidence: unknown", `{"modalities":{"input":["text"],"output":["text"]}}`,
			`{"architecture":{"input_modalities":["text"],"output_modalities":["text"]}}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := js(modelmeta.Normalize(json.RawMessage(c.raw))); got != c.want {
				t.Fatalf("Normalize(%s)\n got %s\nwant %s", c.raw, got, c.want)
			}
		})
	}
}

func TestResolveTakesOwnerThenProviderThenModelsDevFieldByField(t *testing.T) {
	owner := modelmeta.Facts{ContextLength: n(1_000_000), Chat: "ok"}
	reported := modelmeta.Facts{ContextLength: n(128_000), MaxOutputTokens: n(8_192), Chat: "unsupported",
		Architecture: &modelmeta.Architecture{InputModalities: []string{"text"}}}
	external := modelmeta.Facts{ContextLength: n(200_000), MaxInputTokens: n(190_000), MaxOutputTokens: n(64_000),
		Architecture: &modelmeta.Architecture{InputModalities: []string{"text", "image"}, OutputModalities: []string{"text"}},
		Reasoning:    b(true), ReasoningLevels: []string{"low", "high"}}
	cases := []struct {
		name   string
		layers []modelmeta.Facts
		want   string
	}{
		{"nothing", nil, `{}`},
		{"models.dev alone", []modelmeta.Facts{{}, {}, external}, js(external)},
		{"Provider beats models.dev, models.dev fills the rest", []modelmeta.Facts{{}, reported, external},
			`{"context_length":128000,"max_input_tokens":190000,"max_output_tokens":8192,"architecture":{"input_modalities":["text"],"output_modalities":["text"]},"reasoning":true,"reasoning_levels":["low","high"],"chat":"unsupported"}`},
		{"Owner beats both", []modelmeta.Facts{owner, reported, external},
			`{"context_length":1000000,"max_input_tokens":190000,"max_output_tokens":8192,"architecture":{"input_modalities":["text"],"output_modalities":["text"]},"reasoning":true,"reasoning_levels":["low","high"],"chat":"ok"}`},
		{"Owner says no reasoning: levels dropped", []modelmeta.Facts{{Reasoning: b(false)}, {}, external},
			`{"context_length":200000,"max_input_tokens":190000,"max_output_tokens":64000,"architecture":{"input_modalities":["text","image"],"output_modalities":["text"]},"reasoning":false}`},
		{"Owner levels win over models.dev levels", []modelmeta.Facts{{ReasoningLevels: []string{"max"}}, {}, external},
			`{"context_length":200000,"max_input_tokens":190000,"max_output_tokens":64000,"architecture":{"input_modalities":["text","image"],"output_modalities":["text"]},"reasoning":true,"reasoning_levels":["max"]}`},
		{"empty architecture counts as unknown", []modelmeta.Facts{{Architecture: &modelmeta.Architecture{}}, {}, external}, js(external)},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := js(modelmeta.Resolve(c.layers...)); got != c.want {
				t.Fatalf("Resolve\n got %s\nwant %s", got, c.want)
			}
		})
	}
}

func TestServedSaysChatOKUnlessKnownNotTo(t *testing.T) {
	cases := []struct{ in, want string }{{"", "ok"}, {"ok", "ok"}, {"unsupported", "unsupported"}}
	for _, c := range cases {
		if got := modelmeta.Served(modelmeta.Facts{Chat: c.in}).Chat; got != c.want {
			t.Errorf("Served(chat %q).Chat = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestFactsStoredFormRoundTrips(t *testing.T) {
	if (modelmeta.Facts{}).String() != "" || !modelmeta.Parse("").IsZero() || !modelmeta.Parse("not json").IsZero() {
		t.Fatal("empty facts must store as \"\" and read back empty")
	}
	f := modelmeta.Facts{ContextLength: n(5), Reasoning: b(false), Architecture: &modelmeta.Architecture{OutputModalities: []string{"text"}}}
	if got := js(modelmeta.Parse(f.String())); got != js(f) {
		t.Fatalf("round trip = %s, want %s", got, js(f))
	}
}
