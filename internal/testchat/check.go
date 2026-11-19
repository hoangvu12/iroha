package testchat

import (
	"bytes"
	"encoding/json"

	"github.com/hoangvu12/iroha/internal/shape"
)

// ToolCheck is the verdict of the tool-call check on one answer.
type ToolCheck struct {
	Passed bool   `json:"passed"`
	Reason string `json:"reason" doc:"Why it passed or failed, in a sentence."`
	// Call is the first tool call of the answer, as the model wrote it.
	Name      string `json:"name,omitempty" doc:"The tool the model called."`
	Arguments string `json:"arguments,omitempty" doc:"The arguments exactly as the model wrote them."`
	ID        string `json:"id,omitempty" doc:"The call's ID, to send back in messages[].tool_calls[].id."`
}

// CheckTool judges the whole answer (a stream reassembled into one answer)
// of a send in Shape sh that offered the test tool: it passes when the
// first tool call is get_weather with a JSON object naming a city.
func CheckTool(sh shape.Shape, status int, answer []byte) ToolCheck {
	if status < 200 || status > 299 {
		return ToolCheck{Reason: "The Request failed, so the model never answered."}
	}
	calls := toolCalls(sh, answer)
	if len(calls) == 0 {
		return ToolCheck{Reason: "The model answered without calling " + ToolName + "."}
	}
	c := calls[0]
	out := ToolCheck{Name: c.Name, Arguments: string(c.Arguments), ID: c.ID}
	if c.Name != ToolName {
		out.Reason = "The model called " + c.Name + ", a tool it was not offered."
		return out
	}
	var a map[string]any
	raw := bytes.TrimSpace(c.Arguments)
	if json.Unmarshal(raw, &a) != nil || a == nil {
		out.Reason = "The arguments are not a JSON object."
		return out
	}
	city, _ := a["city"].(string)
	if city == "" {
		out.Reason = "The arguments name no city."
		return out
	}
	out.Passed, out.Reason = true, "The model called "+ToolName+" with valid arguments."
	return out
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
