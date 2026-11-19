package testchat

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"strings"

	"github.com/hoangvu12/iroha/internal/shape"
)

// ToolCheck is the verdict of the tool-call check on one answer.
type ToolCheck struct {
	Passed bool   `json:"passed"`
	Reason string `json:"reason" doc:"Why it passed or failed, in a sentence."`
	// Call is the first tool call of the answer, as the model wrote it.
	Name      string `json:"name,omitempty" doc:"The tool the model called (the first call when it made several)."`
	Arguments string `json:"arguments,omitempty" doc:"The arguments exactly as the model wrote them."`
	ID        string `json:"id,omitempty" doc:"The call's ID, to send back in messages[].tool_calls[].id."`
	Calls     int    `json:"calls,omitempty" doc:"How many tool calls the answer made; each is checked, the first failing one is reported."`
}

// CheckTool judges the whole answer (a stream reassembled into one answer)
// of a send in Shape sh that offered the tools named: it passes when the
// model called at least one tool and every call names an offered tool with
// arguments valid against its schema (a JSON object, required properties
// present, each property of its type).
func CheckTool(sh shape.Shape, status int, answer []byte, offered []string) ToolCheck {
	if status < 200 || status > 299 {
		return ToolCheck{Reason: "The Request failed, so the model never answered."}
	}
	calls := toolCalls(sh, answer)
	if len(calls) == 0 {
		what := "any of the tools offered"
		if len(offered) == 1 {
			what = offered[0]
		}
		return ToolCheck{Reason: "The model answered without calling " + what + "."}
	}
	report := calls[0]
	reason := ""
	for _, c := range calls {
		if r := checkCall(c, offered); r != "" {
			report, reason = c, r
			break
		}
	}
	out := ToolCheck{Name: report.Name, Arguments: string(report.Arguments), ID: report.ID, Calls: len(calls)}
	if reason != "" {
		out.Reason = reason
		return out
	}
	out.Passed = true
	if len(calls) == 1 {
		out.Reason = "The model called " + report.Name + " with valid arguments."
	} else {
		names := make([]string, len(calls))
		for i, c := range calls {
			names[i] = c.Name
		}
		out.Reason = fmt.Sprintf("The model made %d tool calls (%s), all with valid arguments.", len(calls), strings.Join(names, ", "))
	}
	return out
}

// checkCall says what is wrong with one call, "" when nothing is.
func checkCall(c ToolCall, offered []string) string {
	t := toolNamed(c.Name)
	if t == nil || !slices.Contains(offered, c.Name) {
		return "The model called " + c.Name + ", a tool it was not offered."
	}
	var a map[string]any
	dec := json.NewDecoder(bytes.NewReader(bytes.TrimSpace(c.Arguments)))
	dec.UseNumber()
	if dec.Decode(&a) != nil || a == nil {
		return "The arguments of " + c.Name + " are not a JSON object."
	}
	if r := validate(t.params, a); r != "" {
		return "The arguments of " + c.Name + " " + r + "."
	}
	return ""
}

// validate checks arguments against a test tool's schema (the subset the
// test tools use: required properties and their types); it says what is
// wrong, "" when nothing is.
func validate(schema obj, a map[string]any) string {
	props, _ := schema.get("properties").(obj)
	required, _ := schema.get("required").([]any)
	for _, r := range required {
		name := r.(string)
		v, ok := a[name]
		if !ok || v == nil {
			return "lack " + name
		}
		if s, isStr := v.(string); isStr && strings.TrimSpace(s) == "" {
			return "give an empty " + name
		}
	}
	for _, p := range props {
		v, ok := a[p.k]
		if !ok || v == nil {
			continue
		}
		want, _ := p.v.(obj).get("type").(string)
		if !hasType(v, want) {
			return fmt.Sprintf("give %s as %s, not %s", p.k, article(want), article(typeOf(v)))
		}
	}
	return ""
}

func hasType(v any, want string) bool {
	switch want {
	case "string":
		_, ok := v.(string)
		return ok
	case "integer":
		n, ok := v.(json.Number)
		if !ok {
			return false
		}
		f, err := n.Float64()
		return err == nil && f == math.Trunc(f)
	case "number":
		_, ok := v.(json.Number)
		return ok
	}
	return true
}

func typeOf(v any) string {
	switch v.(type) {
	case string:
		return "string"
	case json.Number:
		return "number"
	case bool:
		return "boolean"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	}
	return "null"
}

func article(t string) string {
	if t == "" {
		return "a value"
	}
	if strings.ContainsRune("aeiou", rune(t[0])) {
		return "an " + t
	}
	return "a " + t
}

// toolCalls reads the tool calls of a whole answer in Shape sh; arguments
// as the model wrote them (a JSON text).
func toolCalls(sh shape.Shape, answer []byte) []ToolCall {
	var out []ToolCall
	switch sh {
	case shape.OpenAIChat:
		var a struct {
			Choices []struct {
				Message struct {
					ToolCalls []struct {
						ID       string `json:"id"`
						Function struct {
							Name      string `json:"name"`
							Arguments string `json:"arguments"`
						} `json:"function"`
					} `json:"tool_calls"`
				} `json:"message"`
			} `json:"choices"`
		}
		if json.Unmarshal(answer, &a) == nil && len(a.Choices) > 0 {
			for _, c := range a.Choices[0].Message.ToolCalls {
				out = append(out, ToolCall{ID: c.ID, Name: c.Function.Name, Arguments: json.RawMessage(c.Function.Arguments)})
			}
		}
	case shape.OpenAIResponses:
		var a struct {
			Output []struct {
				Type      string `json:"type"`
				CallID    string `json:"call_id"`
				Name      string `json:"name"`
				Arguments string `json:"arguments"`
			} `json:"output"`
		}
		if json.Unmarshal(answer, &a) == nil {
			for _, o := range a.Output {
				if o.Type == "function_call" {
					out = append(out, ToolCall{ID: o.CallID, Name: o.Name, Arguments: json.RawMessage(o.Arguments)})
				}
			}
		}
	case shape.AnthropicMessages:
		var a struct {
			Content []struct {
				Type  string          `json:"type"`
				ID    string          `json:"id"`
				Name  string          `json:"name"`
				Input json.RawMessage `json:"input"`
			} `json:"content"`
		}
		if json.Unmarshal(answer, &a) == nil {
			for _, b := range a.Content {
				if b.Type == "tool_use" {
					out = append(out, ToolCall{ID: b.ID, Name: b.Name, Arguments: b.Input})
				}
			}
		}
	case shape.Gemini:
		var a struct {
			Candidates []struct {
				Content struct {
					Parts []struct {
						FunctionCall *struct {
							ID   string          `json:"id"`
							Name string          `json:"name"`
							Args json.RawMessage `json:"args"`
						} `json:"functionCall"`
					} `json:"parts"`
				} `json:"content"`
			} `json:"candidates"`
		}
		if json.Unmarshal(answer, &a) == nil && len(a.Candidates) > 0 {
			for _, p := range a.Candidates[0].Content.Parts {
				if f := p.FunctionCall; f != nil {
					out = append(out, ToolCall{ID: f.ID, Name: f.Name, Arguments: f.Args})
				}
			}
		}
	}
	return out
}
