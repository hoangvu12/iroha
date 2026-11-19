package gateway_test

import (
	"strings"
	"testing"

	"github.com/hoangvu12/iroha/internal/testkit"
)

// MOD-06: the model the upstream says served it (a dated snapshot here) is
// recorded on the Attempt as reported_model, for every Endpoint Shape,
// passed through and translated, buffered and streamed. The Caller still
// sees the name it asked for.
func TestTheAttemptRecordsTheModelTheUpstreamSaysServedIt(t *testing.T) {
	const snapshot = "gpt-x-2026-01-01"
	srv := testkit.Start(t)
	caller := srv.Client(issue(t, srv, "pi", all))

	// Each Caller route, as a body for model m, streamed or not.
	type route struct {
		name string
		send func(stream bool) *testkit.Response
	}
	routes := func(handle string) []route {
		return []route{
			{"chat", func(stream bool) *testkit.Response {
				b := chatBody("gpt-x")
				b["stream"] = stream
				return caller.Post("/providers/"+handle+"/v1/chat/completions", b)
			}},
			{"responses", func(stream bool) *testkit.Response {
				return caller.Post("/providers/"+handle+"/v1/responses", map[string]any{"model": "gpt-x", "input": "hi", "stream": stream})
			}},
			{"messages", func(stream bool) *testkit.Response {
				b := messages("gpt-x")
				b["stream"] = stream
				return caller.Post("/providers/"+handle+"/v1/messages", b)
			}},
			{"gemini", func(stream bool) *testkit.Response {
				op := "generateContent"
				if stream {
					op = "streamGenerateContent?alt=sse"
				}
				return caller.Post("/providers/"+handle+"/v1beta/models/gpt-x:"+op, generate("hi"))
			}},
		}
	}

	for _, ep := range []struct {
		shape string
		up    *testkit.Upstream
	}{
		{"openai-chat", testkit.NewOpenAIChat(t)},
		{"openai-responses", testkit.NewOpenAIResponses(t)},
		{"anthropic-messages", testkit.NewAnthropic(t)},
		{"gemini", testkit.NewGemini(t)},
	} {
		handle := strings.ReplaceAll(ep.shape, "-", "")
		addEndpointProvider(t, srv, handle, ep.shape, ep.up.URL(), "sk-test-"+handle)
		ep.up.SetServedModel(snapshot)
		for _, rt := range routes(handle) {
			for _, stream := range []bool{false, true} {
				name := ep.shape + " endpoint, " + rt.name + " caller"
				if stream {
					name += ", streamed"
				}
				resp := rt.send(stream).Expect(200)
				if strings.Contains(resp.Text(), snapshot) || !strings.Contains(resp.Text(), "gpt-x") {
					t.Errorf("%s: the Caller sees %s", name, resp.Text())
				}
				r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
				if len(r.Attempts) != 1 {
					t.Fatalf("%s: attempts = %+v", name, r.Attempts)
				}
				if a := r.Attempts[0]; a.ReportedModel != snapshot || a.WireModel != "gpt-x" || r.Model != "gpt-x" {
					t.Errorf("%s: model %q, attempt wire %q reported %q", name, r.Model, a.WireModel, a.ReportedModel)
				}
			}
		}
	}
}
