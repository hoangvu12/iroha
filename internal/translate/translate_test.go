package translate_test

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/hoangvu12/iroha/internal/shape"
	"github.com/hoangvu12/iroha/internal/translate"
)

func TestTargetsAreTheShapesWithCodecs(t *testing.T) {
	if got := translate.Targets(shape.OpenAIChat); !slices.Equal(got, []shape.Shape{shape.AnthropicMessages}) {
		t.Errorf("Chat targets = %v", got)
	}
	if got := translate.Targets(shape.AnthropicMessages); !slices.Equal(got, []shape.Shape{shape.OpenAIChat}) {
		t.Errorf("Anthropic targets = %v", got)
	}
	if translate.Supported(shape.OpenAIChat, shape.OpenAIChat) || translate.Supported(shape.OpenAIChat, shape.Gemini) {
		t.Error("same-Shape and codec-less pairs are not translations")
	}
	if _, err := translate.New(shape.OpenAIChat, shape.Gemini, translate.Options{Now: now}); err == nil {
		t.Error("New accepted a pair without codecs")
	}
}

func newTranslation(t *testing.T, from, to shape.Shape, req string) *translate.Translation {
	t.Helper()
	tr, err := translate.New(from, to, translate.Options{Model: "m", ID: "req_1", Now: now})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tr.Request(context.Background(), []byte(req), "wire-m"); err != nil {
		t.Fatal(err)
	}
	return tr
}

func TestARequestThatCannotBeTranslatedIsTheCallersError(t *testing.T) {
	tr, _ := translate.New(shape.AnthropicMessages, shape.OpenAIChat, translate.Options{Model: "m", Now: now})
	_, err := tr.Request(context.Background(), []byte(`{"model":"m","messages":"not a list"}`), "m")
	var te *translate.Error
	if !errors.As(err, &te) || !strings.Contains(te.Message, "anthropic-messages") {
		t.Fatalf("err = %v", err)
	}
}

func TestUpstreamErrorEventsEndTheStream(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		from, to shape.Shape
		req      string
		events   []string
		wantType string
	}{
		{shape.OpenAIChat, shape.AnthropicMessages, `{"model":"m","max_tokens":10,"messages":[{"role":"user","content":"hi"}],"stream":true}`,
			[]string{`{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"m","content":[],"usage":{"input_tokens":1,"output_tokens":1}}}`,
				`{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`}, "overloaded_error"},
		{shape.AnthropicMessages, shape.OpenAIChat, `{"model":"m","max_tokens":10,"messages":[{"role":"user","content":"hi"}],"stream":true}`,
			[]string{`{"id":"c","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"a"}}]}`,
				`{"error":{"message":"upstream exploded","type":"server_error","code":"boom"}}`}, "boom"},
	}
	for _, tc := range cases {
		tr := newTranslation(t, tc.from, tc.to, tc.req)
		st, err := tr.Stream(translate.StreamOptions{})
		if err != nil {
			t.Fatal(err)
		}
		var got error
		for _, ev := range tc.events {
			if _, got = st.Event(ctx, []byte(ev)); got != nil {
				break
			}
		}
		var ue *translate.UpstreamError
		if !errors.As(got, &ue) || ue.Type != tc.wantType {
			t.Errorf("%s<-%s: err = %v, want an UpstreamError %s", tc.from, tc.to, got, tc.wantType)
		}
	}
}

func TestAStreamCutBeforeItsEndInventsNoEnding(t *testing.T) {
	ctx := context.Background()
	tr := newTranslation(t, shape.OpenAIChat, shape.AnthropicMessages, `{"model":"m","max_tokens":10,"messages":[{"role":"user","content":"hi"}],"stream":true}`)
	st, _ := tr.Stream(translate.StreamOptions{IncludeUsage: true})
	for _, ev := range []string{
		`{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"m","content":[],"usage":{"input_tokens":1,"output_tokens":1}}}`,
		`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}`,
	} {
		if _, err := st.Event(ctx, []byte(ev)); err != nil {
			t.Fatal(err)
		}
	}
	out, err := st.End(ctx)
	if !errors.Is(err, translate.ErrIncomplete) || out != nil {
		t.Fatalf("End = %q, %v", out, err)
	}
}

func TestSanitisedToolNamesNeverCollideWithTheCallersOwn(t *testing.T) {
	// "fs.read" would become fs_read, which the Caller also defines.
	req := `{"model":"m","max_tokens":10,"messages":[{"role":"user","content":"hi"}],"tools":[
		{"type":"function","function":{"name":"fs.read","parameters":{"type":"object"}}},
		{"type":"function","function":{"name":"fs_read","parameters":{"type":"object"}}},
		{"type":"function","function":{"name":"` + strings.Repeat("x.", 40) + `","parameters":{"type":"object"}}}]}`
	tr, _ := translate.New(shape.OpenAIChat, shape.AnthropicMessages, translate.Options{Model: "m", ID: "req_1", Now: now})
	out, err := tr.Request(context.Background(), []byte(req), "m")
	if err != nil {
		t.Fatal(err)
	}
	var sent struct {
		Tools []struct{ Name string } `json:"tools"`
	}
	_ = json.Unmarshal(out, &sent)
	var names []string
	for _, tool := range sent.Tools {
		names = append(names, tool.Name)
	}
	if len(names) != 3 || names[0] != "fs_read_2" || names[1] != "fs_read" || len(names[2]) != 64 || strings.ContainsAny(names[2], ".") {
		t.Fatalf("tools sent = %q", names)
	}
	// The answer calls the sanitised names; the Caller gets its own back.
	ans := `{"id":"msg_1","type":"message","role":"assistant","model":"m","stop_reason":"tool_use","usage":{"input_tokens":1,"output_tokens":1},
		"content":[{"type":"tool_use","id":"t1","name":"fs_read_2","input":{}},{"type":"tool_use","id":"t2","name":"fs_read","input":{}}]}`
	b, err := tr.Response(context.Background(), []byte(ans))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"name":"fs.read"`) || !strings.Contains(string(b), `"name":"fs_read"`) {
		t.Fatalf("answer = %s", b)
	}
}
