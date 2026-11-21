package testchat

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/shape"
)

const CallerName = "Test"

func CallerAs(name string) string { return "Test (as " + name + ")" }

const (
	ReasoningOff    = "off"
	ReasoningLow    = "low"
	ReasoningMedium = "medium"
	ReasoningHigh   = "high"
)

const DefaultPrompt = "Reply with one short sentence so I know you work."

type Send struct {
	Model       string      `json:"model" doc:"A Model Pool name, or <provider handle>/<model ID>, as Callers name models on the global routes."`
	Shape       shape.Shape `json:"shape,omitempty" enum:"openai-chat,openai-responses,anthropic-messages,gemini" doc:"The Shape the test Caller speaks. Default openai-chat."`
	System      string      `json:"system,omitempty" doc:"A system prompt."`
	Messages    []Message   `json:"messages,omitempty" doc:"The conversation so far, oldest first, ending with the user's turn. Default: one user message asking for a short reply."`
	Stream      *bool       `json:"stream,omitempty" doc:"Default true: the answer streams as the Shape's server-sent events."`
	Reasoning   string      `json:"reasoning,omitempty" enum:"off,low,medium,high" doc:"Reasoning effort, written in the Shape's own field: reasoning_effort (OpenAI Chat), reasoning.effort (Responses), thinking.budget_tokens 1024/4096/12000 (Anthropic), thinkingConfig.thinkingBudget (Gemini). off or absent: not set."`
	Tools       []string    `json:"tools,omitempty" doc:"Test tools to offer, by name (GET /api/test/tools lists them: get_weather, get_time, calculate, web_search, fetch_url, lookup_order). The answer carries a check of the model's tool calls."`
	ToolCheck   bool        `json:"tool_check,omitempty" doc:"The older form of tools: [\"get_weather\"]. Ignored when tools names any."`
	MaxTokens   int         `json:"max_tokens,omitempty" doc:"Most output tokens. Default 4096 (plus the reasoning budget on Anthropic)."`
	UpstreamKey string      `json:"upstream_key,omitempty" doc:"Pin every Attempt to this Upstream Key (name or ID) of the model's Provider. It is tried whatever its Key State (as key tests do); failures still change it. Needs <provider>/<model>."`
	Endpoint    string      `json:"endpoint,omitempty" doc:"Pin every Attempt to this Endpoint (name or ID) of the model's Provider. Needs <provider>/<model>."`
	As          string      `json:"as,omitempty" doc:"Send as this Gateway Key (name or ID): its scope applies, the Request is recorded as \"Test (as <name>)\" and never counts as that key's traffic."`
}

type Message struct {
	Role      string     `json:"role" enum:"user,assistant"`
	Content   string     `json:"content"`
	ToolCalls []ToolCall `json:"tool_calls,omitempty" doc:"Assistant turns only: the test tool calls the model made. Iroha answers each in the request with that tool's result (made up, or computed for get_time and calculate)."`
}

type ToolCall struct {
	ID        string          `json:"id,omitempty" doc:"The call's ID as the model gave it; made up when empty."`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments,omitempty" doc:"The arguments, a JSON object (or a string holding one)."`
}

func (s Send) StreamOn() bool { return s.Stream == nil || *s.Stream }

type Built struct {
	Shape  shape.Shape
	Model  string
	Path   string
	Body   []byte
	Stream bool
}

func (s *Send) Check() error {
	s.Model = strings.TrimSpace(s.Model)
	if s.Model == "" {
		return api.Errorf(http.StatusBadRequest, "model_required", "Name a Model Pool or <provider>/<model> (GET /api/test/models lists them).", "The test names no model.")
	}
	if s.Shape == "" {
		s.Shape = shape.OpenAIChat
	}
	if !s.Shape.Valid() {
		return api.BadRequest("Use shape openai-chat, openai-responses, anthropic-messages or gemini.", "shape %q is not a Shape.", s.Shape)
	}
	switch s.Reasoning {
	case "", ReasoningOff, ReasoningLow, ReasoningMedium, ReasoningHigh:
	default:
		return api.BadRequest("Use reasoning off, low, medium or high.", "reasoning %q is not a level.", s.Reasoning)
	}
	if len(s.Messages) == 0 {
		s.Messages = []Message{{Role: "user", Content: DefaultPrompt}}
	}
	for i, m := range s.Messages {
		if m.Role != "user" && m.Role != "assistant" {
			return api.BadRequest("Each message's role is user or assistant; put a system prompt in system.", "messages[%d].role is %q.", i, m.Role)
		}
		if len(m.ToolCalls) > 0 && m.Role != "assistant" {
			return api.BadRequest("Only assistant turns carry tool_calls.", "messages[%d] is a %s turn with tool_calls.", i, m.Role)
		}
	}
	if s.MaxTokens < 0 {
		return api.BadRequest("Send max_tokens of at least 1, or leave it out.", "max_tokens is %d.", s.MaxTokens)
	}
	if len(s.Tools) == 0 && s.ToolCheck {
		s.Tools = []string{ToolName}
	}
	var chosen []string
	for _, name := range s.Tools {
		name = strings.TrimSpace(name)
		if toolNamed(name) == nil {
			return api.Errorf(http.StatusBadRequest, "unknown_tool", "Use the names GET /api/test/tools lists: "+strings.Join(ToolNames(), ", ")+".", "There is no test tool %q.", name)
		}
		if !slices.Contains(chosen, name) {
			chosen = append(chosen, name)
		}
	}
	s.Tools = chosen
	return nil
}

func (s Send) Checked() bool { return len(s.Tools) > 0 }

func budget(level string) int {
	switch level {
	case ReasoningLow:
		return 1024
	case ReasoningMedium:
		return 4096
	case ReasoningHigh:
		return 12000
	}
	return 0
}

func (s Send) reasoning() string {
	if s.Reasoning == ReasoningOff {
		return ""
	}
	return s.Reasoning
}

func (s Send) maxTokens() int {
	if s.MaxTokens > 0 {
		return s.MaxTokens
	}
	return 4096
}

// Providers refuse tool calls in the history of a request that offers no tools.
func (s Send) offered() []*tool {
	var out []*tool
	add := func(name string) {
		if t := toolNamed(name); t != nil && !slices.Contains(out, t) {
			out = append(out, t)
		}
	}
	for _, name := range s.Tools {
		add(name)
	}
	calls := false
	for _, m := range s.Messages {
		for _, c := range m.ToolCalls {
			calls = true
			add(c.Name)
		}
	}
	if calls && len(out) == 0 {
		add(ToolName)
	}
	return out
}

func Build(s Send, now time.Time) (Built, error) {
	b := Built{Shape: s.Shape, Model: s.Model, Stream: s.StreamOn()}
	var body obj
	switch s.Shape {
	case shape.OpenAIChat:
		b.Path, body = "/v1/chat/completions", buildChat(s, now)
	case shape.OpenAIResponses:
		b.Path, body = "/v1/responses", buildResponses(s, now)
	case shape.AnthropicMessages:
		b.Path, body = "/v1/messages", buildAnthropic(s, now)
	case shape.Gemini:
		method := "generateContent"
		if b.Stream {
			method = "streamGenerateContent"
		}
		b.Path, body = "/v1beta/models/"+s.Model+":"+method, buildGemini(s, now)
	default:
		return b, fmt.Errorf("testchat: unknown shape %q", s.Shape)
	}
	raw, err := body.MarshalJSON()
	if err != nil {
		return b, err
	}
	var out bytes.Buffer
	if err := json.Indent(&out, raw, "", "  "); err != nil {
		return b, err
	}
	b.Body = out.Bytes()
	return b, nil
}

func callID(c ToolCall, turn, i int) string {
	if c.ID != "" {
		return c.ID
	}
	return fmt.Sprintf("call_%d_%d", turn, i)
}

func args(c ToolCall) json.RawMessage {
	a := bytes.TrimSpace(c.Arguments)
	if len(a) > 0 && a[0] == '"' {
		var s string
		if json.Unmarshal(a, &s) == nil {
			a = []byte(s)
		}
	}
	if len(a) == 0 || !json.Valid(a) || a[0] != '{' {
		return json.RawMessage(`{}`)
	}
	return json.RawMessage(a)
}

func argsString(c ToolCall) string { return string(args(c)) }

func toolResultString(c ToolCall, now time.Time) string {
	b, _ := toolAnswer(c, now).MarshalJSON()
	return string(b)
}

func (s Send) toolDefs(def func(t *tool) any) []any {
	var out []any
	for _, t := range s.offered() {
		out = append(out, def(t))
	}
	return out
}

func buildChat(s Send, now time.Time) obj {
	var msgs []any
	if s.System != "" {
		msgs = append(msgs, obj{{"role", "system"}, {"content", s.System}})
	}
	for t, m := range s.Messages {
		if len(m.ToolCalls) == 0 {
			msgs = append(msgs, obj{{"role", m.Role}, {"content", m.Content}})
			continue
		}
		var calls []any
		for i, c := range m.ToolCalls {
			calls = append(calls, obj{{"id", callID(c, t, i)}, {"type", "function"}, {"function", obj{{"name", c.Name}, {"arguments", argsString(c)}}}})
		}
		msgs = append(msgs, obj{{"role", "assistant"}, {"content", m.Content}, {"tool_calls", calls}})
		for i, c := range m.ToolCalls {
			msgs = append(msgs, obj{{"role", "tool"}, {"tool_call_id", callID(c, t, i)}, {"content", toolResultString(c, now)}})
		}
	}
	body := obj{{"model", s.Model}, {"messages", msgs}, {"max_tokens", s.maxTokens()}}
	if defs := s.toolDefs(func(t *tool) any {
		return obj{{"type", "function"}, {"function", obj{{"name", t.name}, {"description", t.description}, {"parameters", t.params}}}}
	}); defs != nil {
		body = append(body, kv{"tools", defs})
	}
	if r := s.reasoning(); r != "" {
		body = append(body, kv{"reasoning_effort", r})
	}
	if s.StreamOn() {
		body = append(body, kv{"stream", true}, kv{"stream_options", obj{{"include_usage", true}}})
	}
	return body
}

func buildResponses(s Send, now time.Time) obj {
	var input []any
	for t, m := range s.Messages {
		if m.Content != "" || len(m.ToolCalls) == 0 {
			input = append(input, obj{{"role", m.Role}, {"content", m.Content}})
		}
		for i, c := range m.ToolCalls {
			input = append(input, obj{{"type", "function_call"}, {"call_id", callID(c, t, i)}, {"name", c.Name}, {"arguments", argsString(c)}})
			input = append(input, obj{{"type", "function_call_output"}, {"call_id", callID(c, t, i)}, {"output", toolResultString(c, now)}})
		}
	}
	body := obj{{"model", s.Model}}
	if s.System != "" {
		body = append(body, kv{"instructions", s.System})
	}
	body = append(body, kv{"input", input}, kv{"max_output_tokens", s.maxTokens()})
	if defs := s.toolDefs(func(t *tool) any {
		return obj{{"type", "function"}, {"name", t.name}, {"description", t.description}, {"parameters", t.params}}
	}); defs != nil {
		body = append(body, kv{"tools", defs})
	}
	if r := s.reasoning(); r != "" {
		body = append(body, kv{"reasoning", obj{{"effort", r}}})
	}
	if s.StreamOn() {
		body = append(body, kv{"stream", true})
	}
	return body
}

func buildAnthropic(s Send, now time.Time) obj {
	var msgs []any
	for t, m := range s.Messages {
		if len(m.ToolCalls) == 0 {
			msgs = append(msgs, obj{{"role", m.Role}, {"content", m.Content}})
			continue
		}
		var blocks, results []any
		if m.Content != "" {
			blocks = append(blocks, obj{{"type", "text"}, {"text", m.Content}})
		}
		for i, c := range m.ToolCalls {
			blocks = append(blocks, obj{{"type", "tool_use"}, {"id", callID(c, t, i)}, {"name", c.Name}, {"input", args(c)}})
			results = append(results, obj{{"type", "tool_result"}, {"tool_use_id", callID(c, t, i)}, {"content", toolResultString(c, now)}})
		}
		msgs = append(msgs, obj{{"role", "assistant"}, {"content", blocks}}, obj{{"role", "user"}, {"content", results}})
	}
	limit := s.maxTokens()
	think := budget(s.reasoning())
	if think > 0 && s.MaxTokens == 0 {
		limit += think
	}
	body := obj{{"model", s.Model}, {"max_tokens", limit}}
	if s.System != "" {
		body = append(body, kv{"system", s.System})
	}
	body = append(body, kv{"messages", msgs})
	if defs := s.toolDefs(func(t *tool) any {
		return obj{{"name", t.name}, {"description", t.description}, {"input_schema", t.params}}
	}); defs != nil {
		body = append(body, kv{"tools", defs})
	}
	if think > 0 {
		body = append(body, kv{"thinking", obj{{"type", "enabled"}, {"budget_tokens", think}}})
	}
	if s.StreamOn() {
		body = append(body, kv{"stream", true})
	}
	return body
}

func buildGemini(s Send, now time.Time) obj {
	var contents []any
	for _, m := range s.Messages {
		role := "user"
		if m.Role == "assistant" {
			role = "model"
		}
		var parts []any
		if m.Content != "" || len(m.ToolCalls) == 0 {
			parts = append(parts, obj{{"text", m.Content}})
		}
		for _, c := range m.ToolCalls {
			parts = append(parts, obj{{"functionCall", obj{{"name", c.Name}, {"args", args(c)}}}})
		}
		contents = append(contents, obj{{"role", role}, {"parts", parts}})
		if len(m.ToolCalls) > 0 {
			var results []any
			for _, c := range m.ToolCalls {
				results = append(results, obj{{"functionResponse", obj{{"name", c.Name}, {"response", toolAnswer(c, now)}}}})
			}
			contents = append(contents, obj{{"role", "user"}, {"parts", results}})
		}
	}
	body := obj{}
	if s.System != "" {
		body = append(body, kv{"systemInstruction", obj{{"parts", []any{obj{{"text", s.System}}}}}})
	}
	body = append(body, kv{"contents", contents})
	if defs := s.toolDefs(func(t *tool) any {
		return obj{{"name", t.name}, {"description", t.description}, {"parameters", t.params}}
	}); defs != nil {
		body = append(body, kv{"tools", []any{obj{{"functionDeclarations", defs}}}})
	}
	cfg := obj{{"maxOutputTokens", s.maxTokens()}}
	if think := budget(s.reasoning()); think > 0 {
		cfg = append(cfg, kv{"thinkingConfig", obj{{"thinkingBudget", think}, {"includeThoughts", true}}})
	}
	body = append(body, kv{"generationConfig", cfg})
	return body
}

type obj []kv

type kv struct {
	k string
	v any
}

func (o obj) get(k string) any {
	for _, e := range o {
		if e.k == k {
			return e.v
		}
	}
	return nil
}

func (o obj) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, e := range o {
		if i > 0 {
			b.WriteByte(',')
		}
		k, _ := json.Marshal(e.k)
		b.Write(k)
		b.WriteByte(':')
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf)
		enc.SetEscapeHTML(false)
		if err := enc.Encode(e.v); err != nil {
			return nil, err
		}
		b.Write(bytes.TrimRight(buf.Bytes(), "\n"))
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}
