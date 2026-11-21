package translate_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/hoangvu12/iroha/internal/shape"
	"github.com/hoangvu12/iroha/internal/translate"
)

const (
	confAnthropicReq = `{"model":"m","max_tokens":10,"messages":[{"role":"user","content":"hi"}],"tools":[{"name":"f","input_schema":{"type":"object"}},{"name":"g","input_schema":{"type":"object"}}]}`
	confChatReq      = `{"model":"m","messages":[{"role":"user","content":"hi"}]}`
)

func confChunk(delta, finish string) string {
	return `{"id":"c1","object":"chat.completion.chunk","created":1,"model":"w","choices":[{"index":0,"delta":` + delta + `,"finish_reason":` + finish + `}]}`
}

func confStream(t *testing.T, from, to shape.Shape, req string, events ...string) string {
	t.Helper()
	ctx := context.Background()
	st, err := newTranslation(t, from, to, req).Stream(translate.StreamOptions{})
	if err != nil {
		t.Fatal(err)
	}
	var out []byte
	for _, ev := range events {
		b, err := st.Event(ctx, []byte(ev))
		if err != nil {
			t.Fatalf("event %s: %v", ev, err)
		}
		out = append(out, b...)
	}
	b, err := st.End(ctx)
	if err != nil {
		t.Fatalf("end: %v", err)
	}
	return string(append(out, b...))
}

func confRequest(t *testing.T, from, to shape.Shape, req string) (map[string]any, *translate.Translation) {
	t.Helper()
	tr, err := translate.New(from, to, translate.Options{Model: "m", ID: "req_1", Now: now})
	if err != nil {
		t.Fatal(err)
	}
	out, err := tr.Request(context.Background(), []byte(req), "w")
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatal(err)
	}
	return m, tr
}

func confAnswer(t *testing.T, from, to shape.Shape, req, answer string) map[string]any {
	t.Helper()
	out, err := newTranslation(t, from, to, req).Response(context.Background(), []byte(answer))
	if err != nil {
		t.Fatalf("answer: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestStopReasonsMapBetweenAnthropicAndChatBothWays(t *testing.T) {
	for _, tc := range []struct{ stop, finish string }{
		{"end_turn", "stop"}, {"stop_sequence", "stop"}, {"max_tokens", "length"}, {"tool_use", "tool_calls"},
		{"refusal", "content_filter"}, {"pause_turn", "length"}, {"mystery_reason", "stop"},
	} {
		ans := confAnswer(t, shape.OpenAIChat, shape.AnthropicMessages, confChatReq,
			`{"id":"msg_1","type":"message","role":"assistant","model":"w","stop_reason":"`+tc.stop+`","content":[{"type":"text","text":"x"}],"usage":{"input_tokens":1,"output_tokens":1}}`)
		if got := confObj(confList(ans["choices"])[0])["finish_reason"]; got != tc.finish {
			t.Errorf("Anthropic %s -> Chat finish_reason %v, want %s", tc.stop, got, tc.finish)
		}
		stream := confStream(t, shape.OpenAIChat, shape.AnthropicMessages, confChatReq,
			`{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"w","content":[],"usage":{"input_tokens":1,"output_tokens":1}}}`,
			`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
			`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}`,
			`{"type":"content_block_stop","index":0}`,
			`{"type":"message_delta","delta":{"stop_reason":"`+tc.stop+`","stop_sequence":null},"usage":{"output_tokens":1}}`,
			`{"type":"message_stop"}`)
		if !strings.Contains(stream, `"finish_reason":"`+tc.finish+`"`) {
			t.Errorf("Anthropic %s streamed -> Chat:\n%s", tc.stop, stream)
		}
	}
	ans := confAnswer(t, shape.OpenAIChat, shape.AnthropicMessages, confChatReq,
		`{"id":"msg_1","type":"message","role":"assistant","model":"w","stop_reason":"end_turn","content":[{"type":"tool_use","id":"toolu_1","name":"f","input":{}}],"usage":{"input_tokens":1,"output_tokens":1}}`)
	if got := confObj(confList(ans["choices"])[0])["finish_reason"]; got != "tool_calls" {
		t.Errorf("Anthropic end_turn with a tool_use block -> Chat finish_reason %v, want tool_calls", got)
	}
	stream := confStream(t, shape.OpenAIChat, shape.AnthropicMessages, confChatReq,
		`{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"w","content":[],"usage":{"input_tokens":1,"output_tokens":1}}}`,
		`{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"f","input":{}}}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}`,
		`{"type":"content_block_stop","index":0}`,
		`{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}`,
		`{"type":"message_stop"}`)
	if !strings.Contains(stream, `"finish_reason":"tool_calls"`) {
		t.Errorf("Anthropic end_turn after a streamed tool_use -> Chat:\n%s", stream)
	}

	for _, tc := range []struct{ finish, stop string }{
		{"stop", "end_turn"}, {"length", "max_tokens"}, {"tool_calls", "tool_use"}, {"content_filter", "refusal"}, {"mystery_reason", "end_turn"},
	} {
		ans := confAnswer(t, shape.AnthropicMessages, shape.OpenAIChat, confAnthropicReq,
			`{"id":"c1","object":"chat.completion","created":1,"model":"w","choices":[{"index":0,"finish_reason":"`+tc.finish+`","message":{"role":"assistant","content":"x"}}]}`)
		if ans["stop_reason"] != tc.stop || ans["stop_sequence"] != nil {
			t.Errorf("Chat %s -> Anthropic stop_reason %v (stop_sequence %v), want %s", tc.finish, ans["stop_reason"], ans["stop_sequence"], tc.stop)
		}
		stream := confStream(t, shape.AnthropicMessages, shape.OpenAIChat, confAnthropicReq,
			confChunk(`{"role":"assistant","content":"x"}`, "null"), confChunk(`{}`, `"`+tc.finish+`"`), "[DONE]")
		if !strings.Contains(stream, `"stop_reason":"`+tc.stop+`"`) {
			t.Errorf("Chat %s streamed -> Anthropic:\n%s", tc.finish, stream)
		}
	}
}

func TestAnswersWithBadToolArgumentsOrNoIDsStillTranslate(t *testing.T) {
	ans := confAnswer(t, shape.AnthropicMessages, shape.OpenAIChat, confAnthropicReq,
		`{"object":"chat.completion","created":1,"model":"w","choices":[{"index":0,"finish_reason":"tool_calls","message":{"role":"assistant","content":null,"tool_calls":[
			{"id":"call_1","type":"function","function":{"name":"f","arguments":"{bad"}},
			{"type":"function","function":{"name":"g","arguments":"{\"a\":1}"}}]}}]}`)
	content := confList(ans["content"])
	if ans["id"] != "msg_req_1" || ans["type"] != "message" || ans["role"] != "assistant" || ans["model"] != "m" || ans["stop_reason"] != "tool_use" || len(content) != 2 {
		t.Fatalf("answer = %v", ans)
	}
	first, second := confObj(content[0]), confObj(content[1])
	if first["type"] != "tool_use" || first["id"] != "call_1" || first["name"] != "f" || len(confObj(first["input"])) != 0 || first["input"] == nil {
		t.Errorf("tool call with bad arguments = %v", first)
	}
	if second["id"] != "toolu_req_1_1" || second["name"] != "g" || confObj(second["input"])["a"] != float64(1) {
		t.Errorf("tool call without an id = %v", second)
	}

	stream := confStream(t, shape.AnthropicMessages, shape.OpenAIChat, confAnthropicReq,
		confChunk(`{"role":"assistant","content":null,"tool_calls":[{"index":0,"type":"function","function":{"name":"f","arguments":"{}"}}]}`, "null"),
		confChunk(`{}`, `"tool_calls"`), "[DONE]")
	if !strings.Contains(stream, `"id":"toolu_`) {
		t.Errorf("streamed tool call without an id:\n%s", stream)
	}

	chat := confAnswer(t, shape.OpenAIChat, shape.AnthropicMessages, confChatReq,
		`{"type":"message","role":"assistant","model":"w","stop_reason":"end_turn","content":[{"type":"text","text":"x"}],"usage":{"input_tokens":1,"output_tokens":1}}`)
	if chat["id"] != "chatcmpl-req_1" || chat["object"] != "chat.completion" || chat["model"] != "m" {
		t.Errorf("Chat answer without an upstream id = %v", chat)
	}
}

func TestToolResultImagesReachAChatModel(t *testing.T) {
	history := func(result, after string) string {
		return `{"model":"m","max_tokens":10,"tools":[{"name":"shot","input_schema":{"type":"object"}}],"messages":[
			{"role":"user","content":"look"},
			{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"shot","input":{}}]},
			{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":` + result + `}` + after + `]}]}`
	}
	img := `{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo="}}`
	for _, tc := range []struct {
		name, req, toolText string
		userParts           []string
	}{
		{"text and image", history(`[{"type":"text","text":"see image"},`+img+`]`, ""), "see image", []string{"image_url"}},
		{"image only, then text", history(`[`+img+`]`, `,{"type":"text","text":"next"}`), "[image]", []string{"image_url", "text"}},
	} {
		sent, _ := confRequest(t, shape.AnthropicMessages, shape.OpenAIChat, tc.req)
		msgs := confList(sent["messages"])
		if len(msgs) != 4 {
			t.Fatalf("%s: messages = %v", tc.name, msgs)
		}
		tool, user := confObj(msgs[2]), confObj(msgs[3])
		if tool["role"] != "tool" || tool["tool_call_id"] != "toolu_1" || tool["content"] != tc.toolText {
			t.Errorf("%s: tool message = %v", tc.name, tool)
		}
		parts := confList(user["content"])
		if user["role"] != "user" || len(parts) != len(tc.userParts) {
			t.Fatalf("%s: following user message = %v", tc.name, user)
		}
		for i, typ := range tc.userParts {
			if confObj(parts[i])["type"] != typ {
				t.Errorf("%s: part %d = %v, want %s", tc.name, i, parts[i], typ)
			}
		}
		if u := confStr(confObj(confObj(parts[0])["image_url"])["url"]); u != "data:image/png;base64,iVBORw0KGgo=" {
			t.Errorf("%s: image url = %q", tc.name, u)
		}
	}
}

func TestAnthropicBlocksChatCannotCarryAreDropped(t *testing.T) {
	sent, tr := confRequest(t, shape.AnthropicMessages, shape.OpenAIChat, `{"model":"m","max_tokens":10,"messages":[
		{"role":"user","content":[{"type":"text","text":"q"},{"type":"document","source":{"type":"url","url":"https://example.com/a.pdf"}}]},
		{"role":"assistant","content":[
			{"type":"thinking","thinking":"hmm","signature":"sig"},
			{"type":"redacted_thinking","data":"c2VjcmV0"},
			{"type":"server_tool_use","id":"srvtoolu_1","name":"web_search","input":{"query":"q"}},
			{"type":"web_search_tool_result","tool_use_id":"srvtoolu_1","content":[]},
			{"type":"text","text":"ok"}]},
		{"role":"user","content":"more"}]}`)
	b, _ := json.Marshal(sent)
	for _, gone := range []string{"example.com/a.pdf", "c2VjcmV0", "hmm", "srvtoolu_1", "web_search", "document", "thinking"} {
		if strings.Contains(string(b), gone) {
			t.Errorf("upstream request carries %q: %s", gone, b)
		}
	}
	msgs := confList(sent["messages"])
	if len(msgs) != 3 || !strings.Contains(string(b), `"text":"q"`) || !strings.Contains(string(b), `"text":"ok"`) {
		t.Fatalf("messages = %s", b)
	}
	diag := strings.Join(tr.Diagnostics, "\n")
	for _, want := range []string{"unsupported_media_source", "hosted_tool_history_unsupported"} {
		if !strings.Contains(diag, want) {
			t.Errorf("diagnostics %q lack %s", tr.Diagnostics, want)
		}
	}
}

func TestTwoInterleavedStreamedToolCallsBecomeTwoBlocks(t *testing.T) {
	stream := confStream(t, shape.AnthropicMessages, shape.OpenAIChat, confAnthropicReq,
		confChunk(`{"role":"assistant","content":"Let me "}`, "null"),
		confChunk(`{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"f","arguments":"{\"x\":"}}]}`, "null"),
		confChunk(`{"tool_calls":[{"index":1,"id":"call_b","type":"function","function":{"name":"g","arguments":"{\"y\":"}}]}`, "null"),
		confChunk(`{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}`, "null"),
		confChunk(`{"tool_calls":[{"index":1,"function":{"arguments":"2}"}}]}`, "null"),
		confChunk(`{"content":"done"}`, "null"),
		confChunk(`{}`, `"tool_calls"`), "[DONE]")

	type block struct {
		typ, id, name, text, json string
		started, stopped          int
	}
	blocks := map[int]*block{}
	var order []string
	for _, ev := range strings.Split(strings.TrimSpace(stream), "\n\n") {
		name, data, _ := strings.Cut(ev, "\ndata: ")
		name = strings.TrimPrefix(name, "event: ")
		order = append(order, name)
		var e struct {
			Index        int `json:"index"`
			ContentBlock struct {
				Type, ID, Name string
			} `json:"content_block"`
			Delta struct {
				Type, Text  string
				PartialJSON string `json:"partial_json"`
			} `json:"delta"`
		}
		if err := json.Unmarshal([]byte(data), &e); err != nil {
			t.Fatalf("event %q: %v", ev, err)
		}
		b := blocks[e.Index]
		switch name {
		case "content_block_start":
			if b != nil {
				t.Fatalf("block %d started twice:\n%s", e.Index, stream)
			}
			blocks[e.Index] = &block{typ: e.ContentBlock.Type, id: e.ContentBlock.ID, name: e.ContentBlock.Name, started: 1}
		case "content_block_delta":
			if b == nil || b.stopped > 0 {
				t.Fatalf("delta for block %d outside its start and stop:\n%s", e.Index, stream)
			}
			b.text += e.Delta.Text
			b.json += e.Delta.PartialJSON
		case "content_block_stop":
			if b == nil || b.stopped > 0 {
				t.Fatalf("block %d stopped without a start, or twice:\n%s", e.Index, stream)
			}
			b.stopped++
		}
	}
	want := []block{
		{typ: "text", text: "Let me "},
		{typ: "tool_use", id: "call_a", name: "f", json: `{"x":1}`},
		{typ: "tool_use", id: "call_b", name: "g", json: `{"y":2}`},
		{typ: "text", text: "done"},
	}
	if len(blocks) != len(want) {
		t.Fatalf("%d blocks, want %d:\n%s", len(blocks), len(want), stream)
	}
	for i, w := range want {
		b := blocks[i]
		w.started, w.stopped = 1, 1
		if *b != w {
			t.Errorf("block %d = %+v, want %+v", i, *b, w)
		}
	}
	if order[0] != "message_start" || order[len(order)-1] != "message_stop" || !strings.Contains(stream, `"stop_reason":"tool_use"`) {
		t.Errorf("stream:\n%s", stream)
	}
}

func TestToolChoiceMapsBetweenChatAndAnthropicBothWays(t *testing.T) {
	for _, tc := range []struct{ chat, want string }{
		{`"auto"`, `{"type":"auto"}`}, {`"required"`, `{"type":"any"}`}, {`"none"`, `{"type":"none"}`},
		{`{"type":"function","function":{"name":"f"}}`, `{"name":"f","type":"tool"}`}, {`"bogus"`, ``},
	} {
		sent, tr := confRequest(t, shape.OpenAIChat, shape.AnthropicMessages,
			`{"model":"m","messages":[{"role":"user","content":"hi"}],"tools":[{"type":"function","function":{"name":"f","parameters":{"type":"object"}}}],"tool_choice":`+tc.chat+`}`)
		got := ""
		if v, ok := sent["tool_choice"]; ok {
			b, _ := json.Marshal(v)
			got = string(b)
		}
		if got != tc.want {
			t.Errorf("Chat tool_choice %s -> Anthropic %s, want %s", tc.chat, got, tc.want)
		}
		if tc.want == "" && !strings.Contains(strings.Join(tr.Diagnostics, " "), "unsupported_tool_choice") {
			t.Errorf("dropping tool_choice %s left no diagnostic: %q", tc.chat, tr.Diagnostics)
		}
	}
	for _, tc := range []struct{ anthropic, want string }{
		{`{"type":"auto"}`, `"auto"`}, {`{"type":"any"}`, `"required"`}, {`{"type":"none"}`, `"none"`},
		{`{"type":"tool","name":"f"}`, `{"function":{"name":"f"},"type":"function"}`},
	} {
		sent, _ := confRequest(t, shape.AnthropicMessages, shape.OpenAIChat,
			`{"model":"m","max_tokens":10,"messages":[{"role":"user","content":"hi"}],"tools":[{"name":"f","input_schema":{"type":"object"}}],"tool_choice":`+tc.anthropic+`}`)
		b, _ := json.Marshal(sent["tool_choice"])
		if string(b) != tc.want {
			t.Errorf("Anthropic tool_choice %s -> Chat %s, want %s", tc.anthropic, b, tc.want)
		}
	}
}

func TestAnthropicServerToolsAreNotSentToChatAsFunctions(t *testing.T) {
	sent, tr := confRequest(t, shape.AnthropicMessages, shape.OpenAIChat, `{"model":"m","max_tokens":10,"messages":[{"role":"user","content":"hi"}],"tools":[
		{"name":"get_weather","description":"Weather","input_schema":{"type":"object","properties":{"city":{"type":"string"}}}},
		{"type":"web_search_20250305","name":"web_search","max_uses":3},
		{"type":"bash_20250124","name":"bash"}]}`)
	tools := confList(sent["tools"])
	if len(tools) != 1 {
		t.Fatalf("tools sent = %v", tools)
	}
	fn := confObj(confObj(tools[0])["function"])
	if confObj(tools[0])["type"] != "function" || fn["name"] != "get_weather" || fn["description"] != "Weather" || confObj(fn["parameters"])["type"] != "object" {
		t.Errorf("custom tool = %v", tools[0])
	}
	if ws, ok := sent["web_search_options"]; !ok || ws == nil {
		t.Errorf("web_search did not become web_search_options: %v", sent)
	}
	diag := strings.Join(tr.Diagnostics, "\n")
	if !strings.Contains(diag, "unsupported_search_limit") || !strings.Contains(diag, `unsupported_hosted_tool: OpenAI Chat Completions cannot represent hosted tool "bash_20250124"`) {
		t.Errorf("diagnostics = %q", tr.Diagnostics)
	}
}

func confObj(v any) map[string]any { m, _ := v.(map[string]any); return m }
func confList(v any) []any         { l, _ := v.([]any); return l }
func confStr(v any) string         { s, _ := v.(string); return s }
