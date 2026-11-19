package translate_test

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/shape"
	"github.com/hoangvu12/iroha/internal/translate"
)

var update = flag.Bool("update", false, "rewrite the golden files from the current output")

// goldenCase is one recorded exchange (testdata/golden/<name>.in.json): a
// Caller's request in one Shape, the Endpoint's answer in another, whole
// and streamed. The bodies follow recorded traffic (v1's test fixtures and
// the Providers' documented wire examples).
type goldenCase struct {
	From      shape.Shape     `json:"from"`
	To        shape.Shape     `json:"to"`
	Model     string          `json:"model"`
	WireModel string          `json:"wire_model"`
	Request   json.RawMessage `json:"request"`
	// Answer is the Endpoint's whole answer, if the case has one.
	Answer json.RawMessage `json:"answer"`
	// Stream is the data of each upstream server-sent event, in order.
	Stream       []json.RawMessage `json:"stream"`
	IncludeUsage bool              `json:"include_usage"`
}

var now = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

// TestGolden translates every recorded case and compares the request sent
// upstream, the answer and the stream the Caller gets with
// testdata/golden/<name>.golden. Run with -update to rewrite them after a
// deliberate change (or a RelayKit upgrade), then read the diff.
func TestGolden(t *testing.T) {
	inputs, err := filepath.Glob(filepath.Join("testdata", "golden", "*.in.json"))
	if err != nil || len(inputs) == 0 {
		t.Fatalf("no golden inputs: %v", err)
	}
	for _, in := range inputs {
		name := strings.TrimSuffix(filepath.Base(in), ".in.json")
		t.Run(name, func(t *testing.T) {
			raw, err := os.ReadFile(in)
			if err != nil {
				t.Fatal(err)
			}
			var gc goldenCase
			if err := json.Unmarshal(raw, &gc); err != nil {
				t.Fatalf("%s: %v", in, err)
			}
			got := run(t, gc)
			checkInvariants(t, gc, got)
			path := filepath.Join("testdata", "golden", name+".golden")
			if *update {
				if err := os.WriteFile(path, []byte(got.String()), 0o644); err != nil {
					t.Fatal(err)
				}
				return
			}
			want, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("%v (run go test ./internal/translate -run TestGolden -update)", err)
			}
			if w := strings.ReplaceAll(string(want), "\r\n", "\n"); w != got.String() {
				t.Errorf("%s differs from the golden file.\n--- got:\n%s\n--- want:\n%s", name, got.String(), w)
			}
		})
	}
}

// output is what one case produced.
type output struct {
	request []byte // the body sent upstream
	answer  []byte // the Caller's whole answer
	stream  []byte // the Caller's stream
}

func (o output) String() string {
	var b strings.Builder
	b.WriteString("== request sent upstream ==\n" + indent(o.request) + "\n")
	if o.answer != nil {
		b.WriteString("== answer to the Caller ==\n" + indent(o.answer) + "\n")
	}
	if o.stream != nil {
		b.WriteString("== stream to the Caller ==\n" + string(o.stream))
	}
	return b.String()
}

func indent(b []byte) string {
	var out bytes.Buffer
	if err := json.Indent(&out, b, "", "  "); err != nil {
		return string(b)
	}
	return out.String()
}

func run(t *testing.T, gc goldenCase) output {
	t.Helper()
	ctx := context.Background()
	opts := translate.Options{Model: gc.Model, ID: "req_golden", Now: now}
	tr, err := translate.New(gc.From, gc.To, opts)
	if err != nil {
		t.Fatal(err)
	}
	var o output
	o.request, err = tr.Request(ctx, gc.Request, gc.WireModel)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if gc.Answer != nil {
		if o.answer, err = tr.Response(ctx, gc.Answer); err != nil {
			t.Fatalf("answer: %v", err)
		}
	}
	if gc.Stream != nil {
		// A stream is its own Attempt: a fresh Translation of the same request.
		tr, _ := translate.New(gc.From, gc.To, opts)
		if _, err := tr.Request(ctx, gc.Request, gc.WireModel); err != nil {
			t.Fatal(err)
		}
		st, err := tr.Stream(translate.StreamOptions{IncludeUsage: gc.IncludeUsage})
		if err != nil {
			t.Fatal(err)
		}
		o.stream = []byte{}
		for _, ev := range gc.Stream {
			data := []byte(ev)
			var s string
			if json.Unmarshal(ev, &s) == nil { // a non-JSON payload such as [DONE]
				data = []byte(s)
			}
			out, err := st.Event(ctx, data)
			if err != nil {
				t.Fatalf("stream event %s: %v", ev, err)
			}
			o.stream = append(o.stream, out...)
		}
		out, err := st.End(ctx)
		if err != nil {
			t.Fatalf("stream end: %v", err)
		}
		o.stream = append(o.stream, out...)
	}
	return o
}

// checkInvariants asserts what every translation owes the Caller, whatever
// the golden file says.
func checkInvariants(t *testing.T, gc goldenCase, o output) {
	t.Helper()
	for what, b := range map[string][]byte{"request": o.request, "answer": o.answer, "stream": o.stream} {
		for _, leak := range []string{"billing_usage", "usage_semantic", "claude_cache_creation_5_m_tokens", "iroha-url:"} {
			if bytes.Contains(b, []byte(leak)) {
				t.Errorf("%s carries %q", what, leak)
			}
		}
	}
	var req map[string]any
	if err := json.Unmarshal(o.request, &req); err != nil {
		t.Fatalf("request is not JSON: %v", err)
	}
	if req["model"] != gc.WireModel {
		t.Errorf("request model = %v, want %s", req["model"], gc.WireModel)
	}
	if o.answer != nil {
		var a map[string]any
		if err := json.Unmarshal(o.answer, &a); err != nil || a["model"] != gc.Model {
			t.Errorf("answer model = %v (%v), want %s", a["model"], err, gc.Model)
		}
	}
	if o.stream == nil {
		return
	}
	events := parseSSE(o.stream)
	switch gc.From {
	case shape.OpenAIChat:
		if len(events) == 0 || events[len(events)-1] != "[DONE]" {
			t.Fatalf("a Chat stream must end with [DONE]: %q", events)
		}
		usageChunks := 0
		for _, e := range events[:len(events)-1] {
			var c map[string]any
			if err := json.Unmarshal([]byte(e), &c); err != nil {
				t.Fatalf("chunk %s: %v", e, err)
			}
			if c["model"] != gc.Model || c["id"] == "" || c["created"] != float64(now.Unix()) || c["object"] != "chat.completion.chunk" {
				t.Errorf("chunk not stamped: %s", e)
			}
			if c["usage"] != nil {
				usageChunks++
				if len(c["choices"].([]any)) != 0 {
					t.Errorf("usage on a chunk with choices: %s", e)
				}
			}
		}
		if want := map[bool]int{true: 1, false: 0}[gc.IncludeUsage]; usageChunks != want {
			t.Errorf("usage chunks = %d, want %d", usageChunks, want)
		}
	case shape.AnthropicMessages:
		if !bytes.HasPrefix(o.stream, []byte("event: message_start\n")) || !bytes.HasSuffix(o.stream, []byte("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")) {
			t.Errorf("an Anthropic stream runs from message_start to message_stop:\n%s", o.stream)
		}
	case shape.OpenAIResponses:
		checkResponsesStream(t, gc, o.stream)
	}
}

// checkResponsesStream: a Responses stream runs from response.created to
// response.completed, each event named by its type and numbered in order,
// every response object naming Iroha's id and the Caller's model, and every
// message's text accumulated through a content part as the SDKs expect.
func checkResponsesStream(t *testing.T, gc goldenCase, stream []byte) {
	t.Helper()
	blocks := strings.Split(strings.TrimSpace(string(stream)), "\n\n")
	parts := map[string]bool{}
	var first, last string
	for i, block := range blocks {
		name, data, ok := strings.Cut(block, "\ndata: ")
		name = strings.TrimPrefix(name, "event: ")
		var ev struct {
			Type     string `json:"type"`
			Seq      *int   `json:"sequence_number"`
			ItemID   string `json:"item_id"`
			Response *struct {
				ID    string `json:"id"`
				Model string `json:"model"`
			} `json:"response"`
		}
		if !ok || json.Unmarshal([]byte(data), &ev) != nil || ev.Type != name {
			t.Fatalf("event %d is not a named Responses event: %q", i, block)
		}
		if ev.Seq == nil || *ev.Seq != i {
			t.Errorf("event %d (%s) has sequence_number %v", i, name, ev.Seq)
		}
		if r := ev.Response; r != nil && (r.ID != "resp_req_golden" || r.Model != gc.Model) {
			t.Errorf("%s names response %s, model %s", name, r.ID, r.Model)
		}
		switch name {
		case "response.content_part.added":
			parts[ev.ItemID] = true
		case "response.output_text.delta":
			if !parts[ev.ItemID] {
				t.Errorf("text for %s before its content part", ev.ItemID)
			}
		}
		if i == 0 {
			first = name
		}
		last = name
	}
	if first != "response.created" || last != "response.completed" && last != "response.incomplete" {
		t.Errorf("a Responses stream runs from response.created to response.completed: %s ... %s", first, last)
	}
}

// parseSSE returns the data of each event.
func parseSSE(b []byte) []string {
	var out []string
	for _, block := range strings.Split(strings.TrimSpace(string(b)), "\n\n") {
		for _, line := range strings.Split(block, "\n") {
			if d, ok := strings.CutPrefix(line, "data: "); ok {
				out = append(out, d)
			}
		}
	}
	return out
}
