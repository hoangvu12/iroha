package normalise

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/hoangvu12/iroha/internal/shape"
)

// Bodies below are the ones v1 recorded from its Provider fleet
// (test/inference/normalize-openai-response.test.ts and
// streaming-normalize-openai-response.test.ts in the v1 repository), plus
// GLM's content blocks and Z.ai's finish reasons, which v1 never tested.

var chat = For("https://api.example.com/v1", shape.OpenAIChat)

func messageOf(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var v struct {
		Choices []struct {
			Message map[string]any `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(body, &v); err != nil || len(v.Choices) == 0 {
		t.Fatalf("not an answer: %s", body)
	}
	return v.Choices[0].Message
}

func TestWholeAnswers(t *testing.T) {
	cases := []struct {
		name string
		body string
		want map[string]any // the first choice's message; nil: body unchanged
	}{
		{"think block lifted, vendor fields dropped (REQ-85, REQ-23)",
			`{"id":"chatcmpl-1","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"<think>\nThe user said hi.\n</think>\n\nHello there!","name":"MiniMax AI","audio_content":""},"finish_reason":"stop"}]}`,
			map[string]any{"role": "assistant", "content": "Hello there!", "reasoning_content": "\nThe user said hi.\n"}},
		{"thinking tag", `{"choices":[{"index":0,"message":{"role":"assistant","content":"<thinking>a</thinking>answer"}}]}`,
			map[string]any{"role": "assistant", "content": "answer", "reasoning_content": "a"}},
		{"budget:thinking tag", `{"choices":[{"index":0,"message":{"role":"assistant","content":"<budget:thinking>b</budget:thinking>answer"}}]}`,
			map[string]any{"role": "assistant", "content": "answer", "reasoning_content": "b"}},
		{"unclosed block (answer cut by max_tokens) is all reasoning", `{"choices":[{"index":0,"message":{"role":"assistant","content":"<think>still going"}}]}`,
			map[string]any{"role": "assistant", "content": "", "reasoning_content": "still going"}},
		{"native reasoning_content kept, tags left (REQ-87)", `{"choices":[{"index":0,"message":{"role":"assistant","content":"<think>should-be-ignored</think>visible","reasoning_content":"kept"}}]}`, nil},
		{"OpenRouter reasoning alias kept (REQ-87)", `{"choices":[{"index":0,"message":{"role":"assistant","content":"visible","reasoning":"alias kept"}}]}`, nil},
		{"content repeating native reasoning blanked (REQ-88)", `{"choices":[{"index":0,"message":{"role":"assistant","content":"private thought","reasoning":"private thought"}}]}`,
			map[string]any{"role": "assistant", "content": "", "reasoning": "private thought"}},
		{"plain reply untouched (REQ-22)", `{"choices":[{"index":0,"message":{"role":"assistant","content":"plain reply"}}]}`, nil},
		{"a tag later in the text is the answer's own", `{"choices":[{"index":0,"message":{"role":"assistant","content":"Wrap it in <think></think> tags."}}]}`, nil},
		{"invalid JSON untouched (REQ-22)", `not json {`, nil},
		{"error envelope untouched (REQ-22)", `{"error":{"message":"bad","type":"invalid_request_error","code":"invalid_request"}}`, nil},
		{"name equal to role kept", `{"choices":[{"index":0,"message":{"role":"assistant","content":"hi","name":"assistant"}}]}`, nil},
		{"empty name kept", `{"choices":[{"index":0,"message":{"role":"assistant","content":"hi","name":""}}]}`, nil},
		{"brand name dropped", `{"choices":[{"index":0,"message":{"role":"assistant","content":"hi","name":"MiniMax AI"}}]}`,
			map[string]any{"role": "assistant", "content": "hi"}},
		{"choices not an array", `{"choices":"not-an-array"}`, nil},
		{"no choices", `{"choices":[]}`, nil},
		{"GLM content blocks flattened (REQ-24)",
			`{"id":"chatcmpl-glm","model":"glm-4.6","choices":[{"index":0,"message":{"role":"assistant","content":[{"type":"thinking","thinking":[{"type":"text","text":"Greet back."}]},{"type":"text","text":"Hello!"}]},"finish_reason":"stop"}]}`,
			map[string]any{"role": "assistant", "content": "Hello!", "reasoning_content": "Greet back."}},
		{"Z.ai finish reasons outside Z.ai untouched", `{"choices":[{"index":0,"message":{"role":"assistant","content":"x"},"finish_reason":"sensitive"}]}`, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out, err := chat.Body([]byte(c.body))
			if err != nil {
				t.Fatal(err)
			}
			if c.want == nil {
				if string(out) != c.body {
					t.Fatalf("changed:\n%s", out)
				}
				return
			}
			if got := messageOf(t, out); !reflect.DeepEqual(got, c.want) {
				t.Fatalf("message = %v\nwant %v", got, c.want)
			}
		})
	}
}

func TestEveryChoiceIsNormalisedOnItsOwn(t *testing.T) {
	out, _ := chat.Body([]byte(`{"choices":[{"index":0,"message":{"role":"assistant","content":"<think>a</think>first"}},{"index":1,"message":{"role":"assistant","content":"<think>b</think>second"}}]}`))
	var v struct {
		Choices []struct{ Message map[string]any }
	}
	_ = json.Unmarshal(out, &v)
	if v.Choices[0].Message["content"] != "first" || v.Choices[0].Message["reasoning_content"] != "a" ||
		v.Choices[1].Message["content"] != "second" || v.Choices[1].Message["reasoning_content"] != "b" {
		t.Fatalf("%s", out)
	}
}

func TestRewrittenBodiesKeepNumbersAndHTML(t *testing.T) {
	out, _ := chat.Body([]byte(`{"created":1767225600123,"usage":{"cost":0.000012345678901234},"choices":[{"index":0,"message":{"role":"assistant","content":"<think>x</think><b>&amp;</b>"}}]}`))
	for _, want := range []string{`1767225600123`, `0.000012345678901234`, `"<b>&amp;</b>"`} {
		if !strings.Contains(string(out), want) {
			t.Fatalf("%s lacks %s", out, want)
		}
	}
}

func TestZaiFinishReasons(t *testing.T) {
	zai := For("https://api.z.ai/api/coding/paas/v4", shape.OpenAIChat)
	out, err := zai.Body([]byte(`{"choices":[{"index":0,"message":{"role":"assistant","content":"x"},"finish_reason":"sensitive"}]}`))
	if err != nil || !strings.Contains(string(out), `"finish_reason":"content_filter"`) {
		t.Fatalf("%s %v", out, err)
	}
	out, _ = zai.Body([]byte(`{"choices":[{"index":0,"message":{"role":"assistant","content":"x"},"finish_reason":"model_context_window_exceeded"}]}`))
	if !strings.Contains(string(out), `"finish_reason":"length"`) {
		t.Fatalf("%s", out)
	}
	var f *Failure
	if _, err := zai.Body([]byte(`{"choices":[{"index":0,"message":{"role":"assistant","content":"x"},"finish_reason":"network_error"}]}`)); !errors.As(err, &f) {
		t.Fatalf("network_error = %v", err)
	}
	st := For("https://open.bigmodel.cn/api/paas/v4", shape.OpenAIChat).Stream()
	if _, err := st.Event([]byte(`{"choices":[{"index":0,"delta":{},"finish_reason":"network_error"}]}`)); !errors.As(err, &f) {
		t.Fatalf("streamed network_error = %v", err)
	}
}

// run feeds a stream's data payloads through a normaliser and returns what
// it passes on, ended cleanly when end is set.
func run(t *testing.T, s Set, end bool, payloads ...string) []string {
	t.Helper()
	st := s.Stream()
	var out []string
	for _, p := range payloads {
		res, err := st.Event([]byte(p))
		if err != nil {
			t.Fatal(err)
		}
		for _, r := range res {
			out = append(out, string(r))
		}
	}
	if end {
		for _, r := range st.End() {
			out = append(out, string(r))
		}
	}
	return out
}

func deltas(t *testing.T, events []string) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, e := range events {
		if e == "[DONE]" {
			continue
		}
		var v struct {
			Choices []struct {
				Delta map[string]any `json:"delta"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(e), &v); err != nil || len(v.Choices) == 0 {
			continue
		}
		out = append(out, v.Choices[0].Delta)
	}
	return out
}

func TestStreams(t *testing.T) {
	type m = map[string]any
	cases := []struct {
		name     string
		payloads []string
		want     []m
	}{
		{"think split across deltas, vendor fields dropped (REQ-86, REQ-23)", []string{
			`{"id":"x","choices":[{"index":0,"delta":{"role":"assistant","content":"<think>\nhello","name":"MiniMax AI","audio_content":""}}]}`,
			`{"id":"x","choices":[{"index":0,"delta":{"content":"</think>\n\nHi!"}}]}`,
			`{"id":"x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`, `[DONE]`,
		}, []m{{"role": "assistant", "content": "", "reasoning_content": "\nhello"}, {"content": "Hi!", "reasoning_content": ""}, {}}},
		{"plain reasoning chunks inside the block are reasoning", []string{
			`{"choices":[{"index":0,"delta":{"content":"<think>hello"}}]}`,
			`{"choices":[{"index":0,"delta":{"content":" world"}}]}`,
			`{"choices":[{"index":0,"delta":{"content":"</think>\n\nDone."},"finish_reason":"stop"}]}`, `[DONE]`,
		}, []m{{"content": "", "reasoning_content": "hello"}, {"content": "", "reasoning_content": " world"}, {"content": "Done.", "reasoning_content": ""}}},
		{"tag split inside the word (<th + ink>)", []string{
			`{"choices":[{"index":0,"delta":{"content":"<th"}}]}`,
			`{"choices":[{"index":0,"delta":{"content":"ink>plan</thi"}}]}`,
			`{"choices":[{"index":0,"delta":{"content":"nk>\n"}}]}`,
			`{"choices":[{"index":0,"delta":{"content":"\nAnswer"},"finish_reason":"stop"}]}`, `[DONE]`,
		}, []m{{"content": "", "reasoning_content": ""}, {"content": "", "reasoning_content": "plan"}, {"content": "", "reasoning_content": ""}, {"content": "Answer", "reasoning_content": ""}}},
		{"native reasoning_content kept (REQ-87)", []string{
			`{"choices":[{"index":0,"delta":{"reasoning_content":"kept","content":"<think>ignored</think>visible"},"finish_reason":"stop"}]}`, `[DONE]`,
		}, []m{{"reasoning_content": "kept", "content": "<think>ignored</think>visible"}}},
		{"content echoing OpenRouter's reasoning removed (REQ-88)", []string{
			`{"choices":[{"index":0,"delta":{"content":"The user wants me\n<think>\n","reasoning":"The user wants me"}}]}`,
			`{"choices":[{"index":0,"delta":{"content":"private body","reasoning":"private body"}}]}`,
			`{"choices":[{"index":0,"delta":{"content":"</think>\n\nFinal answer","reasoning":"last thought"},"finish_reason":"stop"}]}`, `[DONE]`,
		}, []m{{"content": "", "reasoning": "The user wants me"}, {"content": "", "reasoning": "private body"}, {"content": "Final answer", "reasoning": "last thought"}}},
		{"GLM content blocks in a delta (REQ-24)", []string{
			`{"choices":[{"index":0,"delta":{"content":[{"type":"thinking","thinking":[{"text":"hmm"}]}]}}]}`,
			`{"choices":[{"index":0,"delta":{"content":[{"type":"text","text":"Hi"}]},"finish_reason":"stop"}]}`, `[DONE]`,
		}, []m{{"content": "", "reasoning_content": "hmm"}, {"content": "Hi"}}},
		{"per choice index", []string{
			`{"choices":[{"index":0,"delta":{"content":"<think>a</think>one"}},{"index":1,"delta":{"content":"<think>b</think>two"}}]}`,
		}, []m{{"content": "one", "reasoning_content": "a"}}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := deltas(t, run(t, chat, false, c.payloads...))
			if len(got) != len(c.want) {
				t.Fatalf("deltas = %v\nwant %v", got, c.want)
			}
			for i := range got {
				if !reflect.DeepEqual(got[i], c.want[i]) {
					t.Fatalf("delta %d = %v\nwant %v", i, got[i], c.want[i])
				}
			}
		})
	}
}

func TestStreamPassesOtherEventsUntouched(t *testing.T) {
	in := []string{
		`{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}`,
		`{"id":"c1","model":"m","choices":[{"index":0,"delta":{"content":"plain text"}}]}`,
		`not json`,
		`{"error":{"message":"bad","type":"invalid_request_error"}}`,
		`{"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
		`{"id":"c1","model":"m","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}`,
		`[DONE]`,
	}
	if got := run(t, chat, true, in...); !reflect.DeepEqual(got, in) {
		t.Fatalf("changed:\n%v", strings.Join(got, "\n"))
	}
	// [DONE] passes once (REQ-65).
	if got := run(t, chat, true, `[DONE]`, `[DONE]`); len(got) != 1 {
		t.Fatalf("got %v", got)
	}
}

func TestHeldTextGoesOutBeforeTheEnd(t *testing.T) {
	got := run(t, chat, false, `{"id":"c","choices":[{"index":0,"delta":{"content":"<thi"}}]}`, `[DONE]`)
	want := []string{
		`{"choices":[{"delta":{"content":"","reasoning_content":""},"index":0}],"id":"c"}`,
		`{"choices":[{"delta":{"content":"<thi","reasoning_content":""},"index":0}],"id":"c","object":"chat.completion.chunk"}`,
		`{"choices":[{"delta":{},"finish_reason":"stop","index":0}],"id":"c","object":"chat.completion.chunk"}`,
		`[DONE]`,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

func TestStreamsWithoutAFinishReasonAreClosed(t *testing.T) {
	// [DONE] with no finish_reason: the closing chunk goes before the usage
	// chunk, and names tool_calls after tool calls.
	got := run(t, chat, true,
		`{"id":"c","model":"qwen","created":1,"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"f","arguments":"{}"}}]}}]}`,
		`{"id":"c","model":"qwen","created":1,"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}`,
		`[DONE]`)
	if len(got) != 4 || got[1] != `{"choices":[{"delta":{},"finish_reason":"tool_calls","index":0}],"created":1,"id":"c","model":"qwen","object":"chat.completion.chunk"}` ||
		!strings.Contains(got[2], `"usage"`) || got[3] != "[DONE]" {
		t.Fatalf("got\n%s", strings.Join(got, "\n"))
	}
	// A body that ends cleanly without either gets both.
	got = run(t, chat, true, `{"id":"c","choices":[{"index":0,"delta":{"content":"Hi"}}]}`)
	if len(got) != 3 || !strings.Contains(got[1], `"finish_reason":"stop"`) || got[2] != "[DONE]" {
		t.Fatalf("got\n%s", strings.Join(got, "\n"))
	}
	// A stream that finished but sent no [DONE] is left as it ended.
	got = run(t, chat, true, `{"id":"c","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":"stop"}]}`)
	if len(got) != 1 {
		t.Fatalf("got\n%s", strings.Join(got, "\n"))
	}
}

func TestReplayedMessageIDsAreDropped(t *testing.T) {
	// v1 test/http/inference-anthropic-v1-messages.test.ts: a replayed
	// assistant turn keeps the id Anthropic gave it (REQ-53).
	body := `{"model":"mistral-large-latest","messages":[{"role":"user","content":"Hello"},{"id":"msg_01ReplayedAssistantTurn","role":"assistant","content":"Hi"},{"role":"user","content":"Again"}]}`
	out := chat.RequestBody([]byte(body))
	if strings.Contains(string(out), "msg_01Replayed") || !strings.Contains(string(out), `{"content":"Hi","role":"assistant"}`) {
		t.Fatalf("%s", out)
	}
	plain := `{"model":"m",  "messages":[{"role":"user","content":"Hello"}], "extra":1.50}`
	if got := chat.RequestBody([]byte(plain)); string(got) != plain {
		t.Fatalf("changed: %s", got)
	}
}

func TestWhichNormalisersApply(t *testing.T) {
	names := func(url string, sh shape.Shape) []string {
		var out []string
		for _, n := range Applying(url, sh) {
			out = append(out, n.Name)
		}
		return out
	}
	general := []string{ChatReasoningTags, ChatContentBlocks, ChatVendorFields, ChatFinishReason, ChatReplayedFields}
	if got := names("https://api.example.com/v1", shape.OpenAIChat); !reflect.DeepEqual(got, general) {
		t.Fatalf("generic = %v", got)
	}
	if got := names("https://open.bigmodel.cn/api/paas/v4", shape.OpenAIChat); len(got) != len(general)+1 {
		t.Fatalf("bigmodel = %v", got)
	}
	if got := names("https://api.anthropic.com/v1", shape.AnthropicMessages); len(got) != 0 {
		t.Fatalf("anthropic = %v", got)
	}
	if !For("https://api.anthropic.com/v1", shape.AnthropicMessages).Empty() || For("https://api.anthropic.com/v1", shape.AnthropicMessages).Stream() != nil {
		t.Fatal("an Anthropic Endpoint has no normalisers")
	}
	for _, n := range Builtin {
		if n.Description == "" || n.Name == "" || (n.Side != Request && n.Side != Response) {
			t.Fatalf("incomplete %+v", n)
		}
	}
}
