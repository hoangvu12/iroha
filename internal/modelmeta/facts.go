package modelmeta

import (
	"encoding/json"
	"math"
	"slices"
	"strconv"
	"strings"
)

// Facts are what is known about one model. Every field is optional: absent
// means unknown. The JSON form is the one Callers' model lists carry, and
// the one Owner overrides are written in.
type Facts struct {
	ContextLength   *int64        `json:"context_length,omitempty" doc:"Context window in tokens."`
	MaxInputTokens  *int64        `json:"max_input_tokens,omitempty" doc:"Most input tokens one request may send."`
	MaxOutputTokens *int64        `json:"max_output_tokens,omitempty" doc:"Most tokens one answer may hold."`
	Architecture    *Architecture `json:"architecture,omitempty" doc:"Input and output modalities."`
	Reasoning       *bool         `json:"reasoning,omitempty" doc:"Whether the model reasons (thinks) before answering."`
	ReasoningLevels []string      `json:"reasoning_levels,omitempty" doc:"Reasoning effort levels it accepts, e.g. [\"low\", \"medium\", \"high\"]."`
	Chat            string        `json:"chat,omitempty" enum:"ok,unsupported" doc:"ok: answers chat requests; unsupported: known not to (embedding, speech, image models)."`
}

// Architecture lists a model's modalities, lower case.
type Architecture struct {
	InputModalities  []string `json:"input_modalities,omitempty" doc:"e.g. [\"text\", \"image\"]."`
	OutputModalities []string `json:"output_modalities,omitempty" doc:"e.g. [\"text\"]."`
}

const (
	ChatOK          = "ok"
	ChatUnsupported = "unsupported"
)

func (f Facts) IsZero() bool {
	return f.ContextLength == nil && f.MaxInputTokens == nil && f.MaxOutputTokens == nil && f.inputs() == nil && f.outputs() == nil &&
		f.Reasoning == nil && len(f.ReasoningLevels) == 0 && f.Chat == ""
}

func (f Facts) inputs() []string {
	if f.Architecture == nil || len(f.Architecture.InputModalities) == 0 {
		return nil
	}
	return f.Architecture.InputModalities
}

func (f Facts) outputs() []string {
	if f.Architecture == nil || len(f.Architecture.OutputModalities) == 0 {
		return nil
	}
	return f.Architecture.OutputModalities
}

func architecture(in, out []string) *Architecture {
	if in == nil && out == nil {
		return nil
	}
	return &Architecture{InputModalities: in, OutputModalities: out}
}

// Resolve merges layers field by field, the first layer that knows a field
// winning: Resolve(owner, reported, modelsDev). Input and output modalities
// are separate fields. When the result says the model does not reason, it
// has no reasoning levels; levels alone say it does.
func Resolve(layers ...Facts) Facts {
	var out Facts
	var in, outs []string
	for _, l := range layers {
		if out.ContextLength == nil {
			out.ContextLength = l.ContextLength
		}
		if out.MaxInputTokens == nil {
			out.MaxInputTokens = l.MaxInputTokens
		}
		if out.MaxOutputTokens == nil {
			out.MaxOutputTokens = l.MaxOutputTokens
		}
		if in == nil {
			in = l.inputs()
		}
		if outs == nil {
			outs = l.outputs()
		}
		if out.Reasoning == nil {
			out.Reasoning = l.Reasoning
		}
		if out.ReasoningLevels == nil && len(l.ReasoningLevels) > 0 {
			out.ReasoningLevels = l.ReasoningLevels
		}
		if out.Chat == "" {
			out.Chat = l.Chat
		}
	}
	out.Architecture = architecture(in, outs)
	if out.Reasoning != nil && !*out.Reasoning {
		out.ReasoningLevels = nil
	}
	if out.Reasoning == nil && len(out.ReasoningLevels) > 0 {
		t := true
		out.Reasoning = &t
	}
	return out
}

// Served is what a Caller's model list says of a model: f, with chat "ok"
// unless the model is known not to chat.
func Served(f Facts) Facts {
	if f.Chat != ChatUnsupported {
		f.Chat = ChatOK
	}
	return f
}

// Parse reads stored Facts ("" is nothing known).
func Parse(s string) Facts {
	var f Facts
	if s != "" {
		_ = json.Unmarshal([]byte(s), &f)
	}
	return f
}

// String is the stored form of f ("" when nothing is known).
func (f Facts) String() string {
	if f.IsZero() {
		return ""
	}
	b, _ := json.Marshal(f)
	return string(b)
}

// Field aliases Providers use (catalog MOD-68), in order of preference.
var (
	contextFields = [][]string{{"context_length"}, {"context_window"}, {"max_context_length"}, {"max_context_tokens"}, {"max_context"},
		{"contextWindow"}, {"contextLength"}, {"ctx_len"}, {"n_ctx"}, {"context_size"}, {"limit", "context"}, {"top_provider", "context_length"}}
	inputFields = [][]string{{"max_input_tokens"}, {"input_token_limit"}, {"inputTokenLimit"}, {"max_prompt_tokens"}, {"max_input"},
		{"limit", "input"}, {"top_provider", "max_prompt_tokens"}}
	outputFields = [][]string{{"max_output_tokens"}, {"output_token_limit"}, {"outputTokenLimit"}, {"max_completion_tokens"}, {"max_output"},
		{"max_tokens"}, {"limit", "output"}, {"top_provider", "max_completion_tokens"}}
	levelFields = [][]string{{"reasoning_levels"}, {"reasoning_efforts"}, {"supported_reasoning_efforts"}, {"reasoning_effort_levels"},
		{"reasoning", "levels"}, {"reasoning", "efforts"}}
)

// Normalize reads one model object as a Provider's model list or models.dev
// reports it. Unknown or malformed fields are left out; it never fails.
func Normalize(raw json.RawMessage) Facts {
	var m map[string]any
	if len(raw) == 0 || json.Unmarshal(raw, &m) != nil {
		return Facts{}
	}
	return normalize(m)
}

func normalize(m map[string]any) Facts {
	var f Facts
	f.MaxInputTokens = firstInt(m, inputFields)
	f.ContextLength = contextLengthOrMaxInput(m, f.MaxInputTokens)
	f.MaxOutputTokens = firstInt(m, outputFields)
	in, out := modalities(m)
	f.Architecture = architecture(in, out)
	f.Reasoning, f.ReasoningLevels = reasoning(m)
	f.Chat = chat(m, in, out)
	return f
}

func contextLengthOrMaxInput(m map[string]any, maxInput *int64) *int64 {
	if n := firstInt(m, contextFields); n != nil {
		return n
	}
	return maxInput
}

func at(m map[string]any, path []string) (any, bool) {
	var v any = m
	for _, k := range path {
		obj, ok := v.(map[string]any)
		if !ok {
			return nil, false
		}
		if v, ok = obj[k]; !ok {
			return nil, false
		}
	}
	return v, true
}

func firstInt(m map[string]any, paths [][]string) *int64 {
	for _, p := range paths {
		if v, ok := at(m, p); ok {
			if n, ok := positiveInt(v); ok {
				return &n
			}
		}
	}
	return nil
}

// maxSafe is the largest integer every JSON reader holds exactly.
const maxSafe = 1<<53 - 1

func positiveInt(v any) (int64, bool) {
	var x float64
	switch t := v.(type) {
	case float64:
		x = t
	case string:
		n, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		if err != nil {
			return 0, false
		}
		x = n
	default:
		return 0, false
	}
	if x <= 0 || x > maxSafe || x != math.Trunc(x) {
		return 0, false
	}
	return int64(x), true
}

func normalizedWords(v any) []string {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	var out []string
	for _, x := range arr {
		s, ok := x.(string)
		if !ok {
			continue
		}
		if s = strings.ToLower(strings.TrimSpace(s)); s != "" && !slices.Contains(out, s) {
			out = append(out, s)
		}
	}
	return out
}

func firstWords(m map[string]any, paths ...[]string) []string {
	for _, p := range paths {
		if v, ok := at(m, p); ok {
			if w := normalizedWords(v); w != nil {
				return w
			}
		}
	}
	return nil
}

// modalities reads architecture.*_modalities, flat *_modalities,
// modalities.{input,output}, or OpenRouter's architecture.modality
// ("text+image->text").
func modalities(m map[string]any) (in, out []string) {
	in = firstWords(m, []string{"architecture", "input_modalities"}, []string{"input_modalities"}, []string{"modalities", "input"})
	out = firstWords(m, []string{"architecture", "output_modalities"}, []string{"output_modalities"}, []string{"modalities", "output"})
	if v, ok := at(m, []string{"architecture", "modality"}); ok && (in == nil || out == nil) {
		if s, ok := v.(string); ok {
			if l, r, ok := strings.Cut(strings.ToLower(s), "->"); ok {
				split := func(s string) []string {
					var w []any
					for _, p := range strings.Split(s, "+") {
						w = append(w, p)
					}
					return normalizedWords(w)
				}
				if in == nil {
					in = split(l)
				}
				if out == nil {
					out = split(r)
				}
			}
		}
	}
	return in, out
}

func truth(v any) (bool, bool) {
	switch t := v.(type) {
	case bool:
		return t, true
	case string:
		switch strings.NewReplacer(" ", "_", "-", "_").Replace(strings.ToLower(strings.TrimSpace(t))) {
		case "ok", "true", "yes", "supported", "available", "enabled":
			return true, true
		case "unsupported", "false", "no", "not_supported", "unavailable", "disabled":
			return false, true
		}
	case map[string]any:
		if s, ok := t["supported"]; ok {
			return truth(s)
		}
	}
	return false, false
}

func reasoning(m map[string]any) (*bool, []string) {
	var levels []string
	for _, p := range levelFields {
		if v, ok := at(m, p); ok {
			if levels = normalizedWords(v); levels != nil {
				break
			}
		}
	}
	// models.dev: reasoning_options [{"type": "effort", "values": [...]}, {"type": "toggle"}, ...]
	if opts, ok := m["reasoning_options"].([]any); ok && levels == nil {
		for _, o := range opts {
			if obj, ok := o.(map[string]any); ok && obj["type"] == "effort" {
				levels = normalizedWords(obj["values"])
			}
		}
	}
	var known *bool
	set := func(b bool) {
		if known == nil {
			known = &b
		}
	}
	for _, p := range [][]string{{"reasoning"}, {"supports_reasoning"}, {"capabilities", "reasoning"}, {"capabilities", "thinking"}, {"thinking"}} {
		if v, ok := at(m, p); ok {
			if b, ok := truth(v); ok {
				set(b)
				break
			}
		}
	}
	if known == nil {
		for _, p := range [][]string{{"supported_parameters"}, {"supported_features"}} {
			for _, w := range firstWords(m, p) {
				if w == "reasoning" || w == "include_reasoning" || w == "thinking" || w == "reasoning_effort" {
					set(true)
				}
			}
		}
	}
	if known == nil && levels != nil {
		set(true)
	}
	if known != nil && !*known {
		levels = nil
	}
	return known, levels
}

var chatEndpoints = []string{"chat/completions", "responses", "messages", "generatecontent", "streamgeneratecontent"}

func chat(m map[string]any, in, out []string) string {
	for _, p := range [][]string{{"chat"}, {"capabilities", "chat"}, {"capabilities", "completion_chat"}} {
		if v, ok := at(m, p); ok {
			if b, ok := truth(v); ok {
				return verdict(b)
			}
		}
	}
	for _, p := range [][]string{{"supported_endpoints"}, {"supportedGenerationMethods"}} {
		if v, ok := at(m, p); ok {
			if eps := normalizedWords(v); eps != nil {
				for _, e := range eps {
					e = strings.Trim(strings.TrimPrefix(strings.TrimPrefix(e, "/"), "v1/"), "/")
					for _, c := range chatEndpoints {
						if e == c || strings.HasSuffix(e, "/"+c) {
							return ChatOK
						}
					}
				}
				return ChatUnsupported
			}
		}
	}
	if in != nil && !slices.Contains(in, "text") || out != nil && !slices.Contains(out, "text") {
		return ChatUnsupported
	}
	if slices.Contains(out, "text") {
		for _, k := range []string{"tool_call", "reasoning", "structured_output"} {
			if b, ok := m[k].(bool); ok && b {
				return ChatOK
			}
		}
		for _, w := range firstWords(m, []string{"supported_features"}) {
			if w == "tools" || w == "json_mode" || w == "reasoning" {
				return ChatOK
			}
		}
	}
	return ""
}

func verdict(b bool) string {
	if b {
		return ChatOK
	}
	return ChatUnsupported
}
