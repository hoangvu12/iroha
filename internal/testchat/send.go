// Package testchat is the test chat's side of the admin API (ticket 23):
// what one test send asks for (Send), the request a Caller of each Shape
// would send for it (Build), the tool-call check (CheckTool), the snippets
// that send the same request to the Gateway (Snippets), and the model
// search behind the chat's model picker. Sending itself is the Gateway's
// (POST /api/test, internal/gateway/testrun.go): it runs the built request
// through the normal inference path as the Test caller.
package testchat

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/shape"
)

// Caller names of test Requests.
const CallerName = "Test"

// CallerAs is the recorded Caller of a test sent as Gateway Key name.
func CallerAs(name string) string { return "Test (as " + name + ")" }

// Reasoning levels.
const (
	ReasoningOff    = "off"
	ReasoningLow    = "low"
	ReasoningMedium = "medium"
	ReasoningHigh   = "high"
)

// DefaultPrompt is what a send with no messages asks.
const DefaultPrompt = "Reply with one short sentence so I know you work."

// Send is one test send: a conversation and the settings to send it with.
type Send struct {
	Model    string      `json:"model" doc:"A Model Pool name, or <provider handle>/<model ID>, as Callers name models on the global routes."`
	Shape    shape.Shape `json:"shape,omitempty" enum:"openai-chat,openai-responses,anthropic-messages,gemini" doc:"The Shape the test Caller speaks. Default openai-chat."`
	System   string      `json:"system,omitempty" doc:"A system prompt."`
	Messages []Message   `json:"messages,omitempty" doc:"The conversation so far, oldest first, ending with the user's turn. Default: one user message asking for a short reply."`
	Stream   *bool       `json:"stream,omitempty" doc:"Default true: the answer streams as the Shape's server-sent events."`
	// Reasoning is written in the Shape's own field, so translation to the
	// Endpoint's Shape is exercised like any Caller's.
	Reasoning string `json:"reasoning,omitempty" enum:"off,low,medium,high" doc:"Reasoning effort, written in the Shape's own field: reasoning_effort (OpenAI Chat), reasoning.effort (Responses), thinking.budget_tokens 1024/4096/12000 (Anthropic), thinkingConfig.thinkingBudget (Gemini). off or absent: not set."`
	ToolCheck bool   `json:"tool_check,omitempty" doc:"Offer the test tool get_weather(city) and report whether the model called it properly."`
	MaxTokens int    `json:"max_tokens,omitempty" doc:"Most output tokens. Default 4096 (plus the reasoning budget on Anthropic)."`
	// Routing.
	UpstreamKey string `json:"upstream_key,omitempty" doc:"Pin every Attempt to this Upstream Key (name or ID) of the model's Provider. It is tried whatever its Key State (as key tests do); failures still change it. Needs <provider>/<model>."`
	Endpoint    string `json:"endpoint,omitempty" doc:"Pin every Attempt to this Endpoint (name or ID) of the model's Provider. Needs <provider>/<model>."`
	As          string `json:"as,omitempty" doc:"Send as this Gateway Key (name or ID): its scope applies, the Request is recorded as \"Test (as <name>)\" and never counts as that key's traffic."`
}

// Message is one turn of a test conversation.
type Message struct {
	Role    string `json:"role" enum:"user,assistant"`
	Content string `json:"content"`
	// ToolCalls are calls an assistant turn made to the test tool; each is
	// answered with a made-up weather report before the next turn.
	ToolCalls []ToolCall `json:"tool_calls,omitempty" doc:"Assistant turns only: the test tool calls the model made. Each is answered with a made-up weather report in the request."`
}

// ToolCall is one call of the test tool.
type ToolCall struct {
	ID        string          `json:"id,omitempty" doc:"The call's ID as the model gave it; made up when empty."`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments,omitempty" doc:"The arguments, a JSON object (or a string holding one)."`
}

// StreamOn reports whether the send streams.
func (s Send) StreamOn() bool { return s.Stream == nil || *s.Stream }

// Built is the request a Caller of the send's Shape would make to the
// Gateway's global route.
type Built struct {
	Shape  shape.Shape
	Model  string // as named on the global routes
	Path   string // the global route's path (Gemini: model and method included)
	Body   []byte // JSON, keys in a readable order
	Stream bool
}

// Test tool.
const (
	ToolName        = "get_weather"
	toolDescription = "Get the current weather in a city."
)

var toolParameters = obj{{"type", "object"}, {"properties", obj{{"city", obj{{"type", "string"}, {"description", "City name, e.g. Hanoi"}}}}}, {"required", []any{"city"}}}

// Check validates a send and fills in its defaults.
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
	return nil
}

// budget is the thinking budget of a level (Anthropic, Gemini).
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

// tools reports whether the request offers the test tool: when the check
// is on, and whenever earlier turns called it (Providers refuse tool calls
// in the history of a request offering no tools).
func (s Send) tools() bool {
	if s.ToolCheck {
		return true
	}
	for _, m := range s.Messages {
		if len(m.ToolCalls) > 0 {
			return true
		}
	}
	return false
}

// Build writes the send as the request a Caller of its Shape would make.
// Call Check first.
func Build(s Send) (Built, error) {
	b := Built{Shape: s.Shape, Model: s.Model, Stream: s.StreamOn()}
	var body obj
	switch s.Shape {
	case shape.OpenAIChat:
		b.Path, body = "/v1/chat/completions", buildChat(s)
	case shape.OpenAIResponses:
		b.Path, body = "/v1/responses", buildResponses(s)
	case shape.AnthropicMessages:
		b.Path, body = "/v1/messages", buildAnthropic(s)
	case shape.Gemini:
		method := "generateContent"
		if b.Stream {
			method = "streamGenerateContent"
		}
		b.Path, body = "/v1beta/models/"+s.Model+":"+method, buildGemini(s)
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

// callID is a tool call's ID, made up when the model gave none.
func callID(c ToolCall, turn, i int) string {
	if c.ID != "" {
		return c.ID
	}
	return fmt.Sprintf("call_%d_%d", turn, i)
}

// args is a tool call's arguments as a JSON object.
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

// argsString is a tool call's arguments as the JSON string OpenAI Shapes use.
func argsString(c ToolCall) string { return string(args(c)) }

// toolResult is the made-up answer of the test tool.
func toolResult(c ToolCall) obj {
	var a struct {
		City string `json:"city"`
	}
	_ = json.Unmarshal(args(c), &a)
	city := a.City
	if city == "" {
		city = "Hanoi"
	}
	return obj{{"city", city}, {"temperature_c", 24}, {"conditions", "partly cloudy"}, {"wind", "light east wind"}}
}

func toolResultString(c ToolCall) string {
	b, _ := toolResult(c).MarshalJSON()
	return string(b)
}

func buildChat(s Send) obj {
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
			msgs = append(msgs, obj{{"role", "tool"}, {"tool_call_id", callID(c, t, i)}, {"content", toolResultString(c)}})
		}
	}
	body := obj{{"model", s.Model}, {"messages", msgs}, {"max_tokens", s.maxTokens()}}
	if s.tools() {
		body = append(body, kv{"tools", []any{obj{{"type", "function"}, {"function", obj{{"name", ToolName}, {"description", toolDescription}, {"parameters", toolParameters}}}}}})
	}
	if r := s.reasoning(); r != "" {
		body = append(body, kv{"reasoning_effort", r})
	}
	if s.StreamOn() {
		body = append(body, kv{"stream", true}, kv{"stream_options", obj{{"include_usage", true}}})
	}
	return body
}

func buildResponses(s Send) obj {
	var input []any
	for t, m := range s.Messages {
		if m.Content != "" || len(m.ToolCalls) == 0 {
			input = append(input, obj{{"role", m.Role}, {"content", m.Content}})
		}
		for i, c := range m.ToolCalls {
			input = append(input, obj{{"type", "function_call"}, {"call_id", callID(c, t, i)}, {"name", c.Name}, {"arguments", argsString(c)}})
			input = append(input, obj{{"type", "function_call_output"}, {"call_id", callID(c, t, i)}, {"output", toolResultString(c)}})
		}
	}
	body := obj{{"model", s.Model}}
	if s.System != "" {
		body = append(body, kv{"instructions", s.System})
	}
	body = append(body, kv{"input", input}, kv{"max_output_tokens", s.maxTokens()})
	if s.tools() {
		body = append(body, kv{"tools", []any{obj{{"type", "function"}, {"name", ToolName}, {"description", toolDescription}, {"parameters", toolParameters}}}})
	}
	if r := s.reasoning(); r != "" {
		body = append(body, kv{"reasoning", obj{{"effort", r}}})
	}
	if s.StreamOn() {
		body = append(body, kv{"stream", true})
	}
	return body
}

func buildAnthropic(s Send) obj {
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
			results = append(results, obj{{"type", "tool_result"}, {"tool_use_id", callID(c, t, i)}, {"content", toolResultString(c)}})
		}
		msgs = append(msgs, obj{{"role", "assistant"}, {"content", blocks}}, obj{{"role", "user"}, {"content", results}})
	}
	msgs = mergeUserTurns(msgs)
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
	if s.tools() {
		body = append(body, kv{"tools", []any{obj{{"name", ToolName}, {"description", toolDescription}, {"input_schema", toolParameters}}}})
	}
	if think > 0 {
		body = append(body, kv{"thinking", obj{{"type", "enabled"}, {"budget_tokens", think}}})
	}
	if s.StreamOn() {
		body = append(body, kv{"stream", true})
	}
	return body
}

// mergeUserTurns joins a tool-result turn with the user turn after it:
// Anthropic wants turns to alternate.
func mergeUserTurns(msgs []any) []any {
	var out []any
	for _, m := range msgs {
		o := m.(obj)
		if len(out) > 0 && o.get("role") == "user" && out[len(out)-1].(obj).get("role") == "user" {
			prev := out[len(out)-1].(obj)
			out[len(out)-1] = obj{{"role", "user"}, {"content", append(blocksOf(prev.get("content")), blocksOf(o.get("content"))...)}}
			continue
		}
		out = append(out, o)
	}
	return out
}

func blocksOf(content any) []any {
	if s, ok := content.(string); ok {
		return []any{obj{{"type", "text"}, {"text", s}}}
	}
	return content.([]any)
}

func buildGemini(s Send) obj {
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
				results = append(results, obj{{"functionResponse", obj{{"name", c.Name}, {"response", toolResult(c)}}}})
			}
			contents = append(contents, obj{{"role", "user"}, {"parts", results}})
		}
	}
	body := obj{}
	if s.System != "" {
		body = append(body, kv{"systemInstruction", obj{{"parts", []any{obj{{"text", s.System}}}}}})
	}
	body = append(body, kv{"contents", contents})
	if s.tools() {
		body = append(body, kv{"tools", []any{obj{{"functionDeclarations", []any{obj{{"name", ToolName}, {"description", toolDescription}, {"parameters", toolParameters}}}}}}})
	}
	cfg := obj{{"maxOutputTokens", s.maxTokens()}}
	if think := budget(s.reasoning()); think > 0 {
		cfg = append(cfg, kv{"thinkingConfig", obj{{"thinkingBudget", think}, {"includeThoughts", true}}})
	}
	body = append(body, kv{"generationConfig", cfg})
	return body
}

// obj is a JSON object that keeps its keys in the order written, so built
// requests and snippets read in a natural order.
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

// MarshalJSON writes the object with its keys in order.
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
