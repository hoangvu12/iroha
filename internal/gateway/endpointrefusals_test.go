package gateway_test

import (
	"strings"
	"testing"

	"github.com/hoangvu12/iroha/internal/testkit"
)

// Endpoint refusals (ticket 42): a 413 from a proxy's body limit, or a 404
// page from a wrong path, belongs to that Endpoint, not to the request. The
// built-in rules endpoint-body-too-large and endpoint-path-not-found say
// retry_elsewhere, so another candidate serves and the key is left alone.

const nginx413 = "<html>\r\n<head><title>413 Request Entity Too Large</title></head>\r\n<body>\r\n<center><h1>413 Request Entity Too Large</h1></center>\r\n<hr><center>nginx/1.24.0</center>\r\n</body>\r\n</html>\r\n"

func TestAnEndpointRefusalIsServedByAnotherKeyOnAnotherEndpoint(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		rule   string
		reply  testkit.Responder
	}{
		{"413 nginx page", 413, "endpoint-body-too-large", testkit.Raw(413, "text/html", nginx413)},
		{"404 page not found", 404, "endpoint-path-not-found", testkit.Raw(404, "text/plain; charset=utf-8", "404 page not found\n")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := testkit.Start(t)
			a, b := testkit.NewOpenAIChat(t), testkit.NewOpenAIChat(t)
			srv.Admin.Post("/api/providers", map[string]any{"handle": "acme"}).Expect(201)
			srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": "a", "url": a.URL(), "shape": "openai-chat"}).Expect(201)
			srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": "b", "url": b.URL(), "shape": "openai-chat"}).Expect(201)
			// The plan of the first Request: (ka, a), then (kb, b).
			srv.Admin.Post("/api/providers/acme/keys", map[string]any{"name": "ka", "secret": "sk-test-a", "endpoints": []string{"a"}}).Expect(201)
			srv.Admin.Post("/api/providers/acme/keys", map[string]any{"name": "kb", "secret": "sk-test-b", "endpoints": []string{"b"}}).Expect(201)
			caller := srv.Client(issue(t, srv, "pi", all))
			a.Default(tc.reply)
			b.Default(b.Text("served by b"))

			resp := caller.Post(chatPath, chat("m")).Expect(200)
			if !strings.Contains(resp.Text(), "served by b") {
				t.Fatalf("answer = %s", resp.Body)
			}
			r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
			if len(r.Attempts) != 2 || r.Endpoint != "b" || r.UpstreamKey != "kb" {
				t.Fatalf("attempts = %+v", r.Attempts)
			}
			if at := r.Attempts[0]; at.Endpoint != "a" || at.UpstreamKey != "ka" || at.Status != tc.status || at.Rule != tc.rule || at.Outcome != "retry_elsewhere" {
				t.Fatalf("attempt on a = %+v", at)
			}
			k := readKey(t, srv, "ka")
			if k.State.State != "active" || len(k.ModelGaps) != 0 || len(k.EndpointGaps) != 0 || len(k.CoolingModels) != 0 {
				t.Fatalf("ka = %+v, model gaps %+v, endpoint gaps %+v, cooling %+v", k.State, k.ModelGaps, k.EndpointGaps, k.CoolingModels)
			}
			for _, kind := range []string{"key.state", "model_gap", "endpoint_gap"} {
				if ev := srv.Logs("kind=" + kind); len(ev) != 0 {
					t.Fatalf("%s events = %+v", kind, ev)
				}
			}
		})
	}
}
