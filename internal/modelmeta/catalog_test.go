package modelmeta_test

import (
	"testing"

	"github.com/hoangvu12/iroha/internal/modelmeta"
)

// api.json: models per models.dev provider (brand).
const providersJSON = `{
  "anthropic": {"id": "anthropic", "models": {
    "claude-sonnet-4-6": {"id": "claude-sonnet-4-6", "limit": {"context": 1000000, "output": 64000}, "reasoning": true,
      "reasoning_options": [{"type": "effort", "values": ["low", "medium", "high", "max"]}]},
    "claude-opus-4-1": {"id": "claude-opus-4-1", "limit": {"context": 200000, "output": 32000}},
    "claude-opus-4-fast": {"id": "claude-opus-4-fast", "limit": {"context": 200000, "output": 16000}}
  }},
  "zai-coding-plan": {"models": {
    "glm-4.6": {"id": "glm-4.6", "limit": {"context": 204800, "output": 131072}, "modalities": {"input": ["text"], "output": ["text"]}}
  }},
  "openrouter": {"models": {
    "openai/gpt-4o": {"id": "openai/gpt-4o", "limit": {"context": 128000, "output": 16384}},
    "deepseek/deepseek-r1": {"id": "deepseek/deepseek-r1", "limit": {"context": 163840, "output": 65536}}
  }},
  "reseller": {"models": {
    "gpt-4o": {"id": "gpt-4o", "limit": {"context": 64000, "output": 4096}}
  }}
}`

// models.json: models keyed by maker.
const makersJSON = `{
  "openai/gpt-4o": {"id": "gpt-4o", "limit": {"context": 128000, "output": 16384}, "modalities": {"input": ["text", "image"], "output": ["text"]}},
  "openai/gpt-4o-mini": {"id": "gpt-4o-mini", "limit": {"context": 128000, "output": 16384}},
  "openai/whisper-1": {"id": "whisper-1", "modalities": {"input": ["audio"], "output": ["text"]}, "temperature": true},
  "anthropic/claude-sonnet-4-6": {"id": "claude-sonnet-4-6", "limit": {"context": 1000000, "output": 64000},
    "modalities": {"input": ["text", "image", "pdf"], "output": ["text"]}},
  "meta/muse-wonder-1.0": {"id": "muse-wonder-1.0", "limit": {"context": 1048576, "output": 131072}},
  "meta/muse-wonder-full": {"id": "muse-wonder-full", "limit": {"context": 1048576}},
  "meta/muse-spark-1.1": {"id": "muse-spark-1.1", "limit": {"context": 1000}},
  "meta/muse-spark-1.2": {"id": "muse-spark-1.2", "limit": {"context": 2000}},
  "minimax/image-01": {"id": "image-01", "limit": {"context": 1000}},
  "first/shared": {"id": "shared", "limit": {"context": 1000}},
  "second/shared": {"id": "shared", "limit": {"context": 2000}},
  "first/twin": {"id": "twin", "limit": {"context": 3000}},
  "second/twin": {"id": "twin", "limit": {"context": 3000}},
  "deepseek/deepseek-r1": {"id": "deepseek-r1", "limit": {"context": 128000, "output": 32768}, "reasoning": true},
  "x/model-4.7": {"id": "model-4.7", "limit": {"context": 4700}},
  "x/model-4-8": {"id": "model-4-8", "limit": {"context": 4800}},
  "empty/nothing": {"id": "nothing", "name": "Nothing known"}
}`

func TestLookupMatchesExactlyOrNearlyAndNeverGuesses(t *testing.T) {
	cat, err := modelmeta.NewCatalog([]byte(providersJSON), []byte(makersJSON))
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name, brand, model, want string
	}{
		// By the model alone (no brand): models.json.
		{"exact, any case", "", "GPT-4o", `{"context_length":128000,"max_output_tokens":16384,"architecture":{"input_modalities":["text","image"],"output_modalities":["text"]}}`},
		{"maker-qualified ID", "", "openai/gpt-4o-mini", `{"context_length":128000,"max_output_tokens":16384}`},
		{"other path prefix: model part", "", "requesty/openai/gpt-4o-mini", `{"context_length":128000,"max_output_tokens":16384}`},
		{"routing variant ignored", "", "deepseek/deepseek-r1:free", `{"context_length":128000,"max_output_tokens":32768,"reasoning":true}`},
		{"audio model is not chat", "", "whisper-1", `{"architecture":{"input_modalities":["audio"],"output_modalities":["text"]},"chat":"unsupported"}`},
		{"dotted version read as dashed", "", "claude-sonnet-4.6", `{"context_length":1000000,"max_output_tokens":64000,"architecture":{"input_modalities":["text","image","pdf"],"output_modalities":["text"]}}`},
		{"dashed version read as dotted", "", "model-4-7", `{"context_length":4700}`},
		{"bare name to its single numbered release", "", "muse-wonder", `{"context_length":1048576,"max_output_tokens":131072}`},
		{"several numbered releases: nothing", "", "muse-spark", `{}`},
		{"name ending in a number is no release family", "", "claude-opus-4", `{}`},
		{"one-word name is no release family", "", "image", `{}`},
		{"no fuzzy prefix: sibling never matches", "", "gpt-4o-mini-high", `{}`},
		{"no fuzzy prefix: shorter name", "", "gpt-4", `{}`},
		{"ambiguous across makers: nothing", "", "shared", `{}`},
		{"identical facts across makers are not ambiguous", "", "twin", `{"context_length":3000}`},
		{"unknown", "", "nope", `{}`},
		{"entry with nothing useful is skipped", "", "nothing", `{}`},

		// By brand: api.json first, models.json fills the rest.
		{"brand entry wins, maker fills", "anthropic", "claude-sonnet-4-6",
			`{"context_length":1000000,"max_output_tokens":64000,"architecture":{"input_modalities":["text","image","pdf"],"output_modalities":["text"]},"reasoning":true,"reasoning_levels":["low","medium","high","max"]}`},
		{"brand with dotted spelling", "anthropic", "claude-sonnet-4.6",
			`{"context_length":1000000,"max_output_tokens":64000,"architecture":{"input_modalities":["text","image","pdf"],"output_modalities":["text"]},"reasoning":true,"reasoning_levels":["low","medium","high","max"]}`},
		{"brand only knows it", "zai-coding-plan", "glm-4.6", `{"context_length":204800,"max_output_tokens":131072,"architecture":{"input_modalities":["text"],"output_modalities":["text"]}}`},
		{"brand case ignored", "ZAI-Coding-Plan", "GLM-4.6", `{"context_length":204800,"max_output_tokens":131072,"architecture":{"input_modalities":["text"],"output_modalities":["text"]}}`},
		{"another brand's facts never apply", "anthropic", "glm-4.6", `{}`},
		{"brand with slashed IDs", "openrouter", "deepseek/deepseek-r1:free", `{"context_length":163840,"max_output_tokens":65536,"reasoning":true}`},
		{"brand facts beat the maker's", "reseller", "gpt-4o", `{"context_length":64000,"max_output_tokens":4096,"architecture":{"input_modalities":["text","image"],"output_modalities":["text"]}}`},
		{"unknown brand: maker catalog only", "nousresearch", "gpt-4o-mini", `{"context_length":128000,"max_output_tokens":16384}`},
		{"name ending in a number within a brand", "anthropic", "claude-opus-4", `{}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := js(cat.Lookup(c.brand, c.model)); got != c.want {
				t.Fatalf("Lookup(%q, %q)\n got %s\nwant %s", c.brand, c.model, got, c.want)
			}
		})
	}
}

func TestNewCatalogRefusesFilesThatAreNotCatalogs(t *testing.T) {
	for _, body := range []string{`not json`, `[]`, `{}`, `{"a": {"models": {}}}`} {
		if _, err := modelmeta.NewCatalog([]byte(body), nil); err == nil {
			t.Errorf("api.json %s accepted", body)
		}
		if _, err := modelmeta.NewCatalog(nil, []byte(body)); err == nil {
			t.Errorf("models.json %s accepted", body)
		}
	}
	var nilCat *modelmeta.Catalog
	if got := js(nilCat.Lookup("openai", "gpt-4o")); got != `{}` {
		t.Fatalf("nil catalog lookup = %s", got)
	}
}
