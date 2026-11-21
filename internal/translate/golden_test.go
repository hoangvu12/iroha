package translate_test

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/caching"
	"github.com/hoangvu12/iroha/internal/shape"
	"github.com/hoangvu12/iroha/internal/translate"
)

var update = flag.Bool("update", false, "rewrite the golden files from the current output")

type goldenCase struct {
	From         shape.Shape       `json:"from"`
	To           shape.Shape       `json:"to"`
	Model        string            `json:"model"`
	WireModel    string            `json:"wire_model"`
	Request      json.RawMessage   `json:"request"`
	Answer       json.RawMessage   `json:"answer"`
	Stream       []json.RawMessage `json:"stream"`
	IncludeUsage bool              `json:"include_usage"`
	// Gemini says it streams in the URL (:streamGenerateContent), not the body.
	CallerStream bool `json:"caller_stream"`
	Caching      struct {
		Markers        caching.Markers `json:"markers"`
		PromptCacheKey string          `json:"prompt_cache_key"`
		Fields         bool            `json:"fields"`
	} `json:"caching"`
}

var now = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

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

type output struct {
	request []byte
	answer  []byte
	stream  []byte
	// RelayKit names answers and tool calls from Gemini with random UUIDs,
	// written as <uuid>.
	randomIDs bool
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
	if o.randomIDs {
		return randomID.ReplaceAllString(b.String(), "<uuid>")
	}
	return b.String()
}

var randomID = regexp.MustCompile(`[0-9a-f]{32}`)

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
	opts := translate.Options{Model: gc.Model, ID: "req_golden", Now: now, Stream: gc.CallerStream,
		Caching: translate.Caching{Markers: gc.Caching.Markers, PromptCacheKey: gc.Caching.PromptCacheKey, Fields: gc.Caching.Fields}}
	tr, err := translate.New(gc.From, gc.To, opts)
	if err != nil {
		t.Fatal(err)
	}
	o := output{randomIDs: gc.To == shape.Gemini}
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
			if json.Unmarshal(ev, &s) == nil {
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
	if gc.To == shape.Gemini { // the model goes in the URL
		if _, ok := req["model"]; ok {
			t.Errorf("a Gemini request names its model in the URL, not the body: %v", req["model"])
		}
	} else if req["model"] != gc.WireModel {
		t.Errorf("request model = %v, want %s", req["model"], gc.WireModel)
	}
	modelField := "model"
	if gc.From == shape.Gemini {
		modelField = "modelVersion"
	}
	if o.answer != nil {
		var a map[string]any
		if err := json.Unmarshal(o.answer, &a); err != nil || a[modelField] != gc.Model {
			t.Errorf("answer %s = %v (%v), want %s", modelField, a[modelField], err, gc.Model)
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
		if o.answer != nil {
			blocks := strings.Split(strings.TrimSpace(string(o.stream)), "\n\n")
			_, data, _ := strings.Cut(blocks[len(blocks)-1], "\ndata: ")
			var ev, a struct {
				Usage    json.RawMessage `json:"usage"`
				Response struct {
					Usage json.RawMessage `json:"usage"`
				} `json:"response"`
			}
			if json.Unmarshal([]byte(data), &ev) != nil || json.Unmarshal(o.answer, &a) != nil || !bytes.Equal(ev.Response.Usage, a.Usage) {
				t.Errorf("the stream closes with usage %s, the whole answer has %s", ev.Response.Usage, a.Usage)
			}
		}
	case shape.Gemini:
		finished := false
		for _, e := range events {
			var c struct {
				ModelVersion string `json:"modelVersion"`
				Candidates   []struct {
					FinishReason string `json:"finishReason"`
				}
			}
			if err := json.Unmarshal([]byte(e), &c); err != nil || c.ModelVersion != gc.Model {
				t.Errorf("chunk not stamped with the Caller's model: %s", e)
			}
			for _, cand := range c.Candidates {
				finished = finished || cand.FinishReason != ""
			}
		}
		if !finished {
			t.Errorf("a Gemini stream ends with a finishReason:\n%s", o.stream)
		}
	}
}

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
