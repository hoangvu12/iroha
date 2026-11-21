package requests_test

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/gatewaykeys"
	"github.com/hoangvu12/iroha/internal/requests"
	"github.com/hoangvu12/iroha/internal/store"
	"github.com/hoangvu12/iroha/internal/testkit"
)

func keyNamed(t *testing.T, srv *testkit.Server, name string) (*testkit.Client, gatewaykeys.GatewayKey) {
	t.Helper()
	var out gatewaykeys.GatewayKeyResult
	srv.Admin.Post("/api/gateway-keys", map[string]any{"name": name, "scope": map[string]any{"all": true}}).Expect(201).JSON(&out)
	return srv.Client(out.GatewayKey.Secret), out.GatewayKey
}

func page(t *testing.T, srv *testkit.Server, q string) requests.RequestPage {
	t.Helper()
	var p requests.RequestPage
	srv.Admin.Get("/api/requests?" + q).Expect(200).JSON(&p)
	return p
}

func statsOf(t *testing.T, srv *testkit.Server, q string) requests.Stats {
	t.Helper()
	var s requests.Stats
	srv.Admin.Get("/api/requests/stats?" + q).Expect(200).JSON(&s)
	return s
}

func slow(t *testing.T, srv *testkit.Server, up *testkit.Upstream, c *testkit.Client, model string, d time.Duration) {
	t.Helper()
	release := make(chan struct{})
	n := len(up.Requests())
	up.Enqueue(up.Text("ok").HoldUntil(release))
	done := make(chan struct{})
	go func() {
		defer close(done)
		resp := c.Open(http.MethodPost, chatPath, fmt.Sprintf(`{"model":%q,"messages":[]}`, model))
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
	}()
	up.Await(n + 1)
	srv.Clock.Advance(d)
	close(release)
	<-done
}

func ids(rs []requests.Request) []string {
	out := make([]string, len(rs))
	for i, r := range rs {
		out[i] = r.ID
	}
	return out
}

func TestStatsDescribeTheRequestsTheSameFiltersList(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, up.URL())
	alice, _ := keyNamed(t, srv, "alice")
	bob, _ := keyNamed(t, srv, "bob0")

	if s := statsOf(t, srv, ""); s.Requests != 0 || s.MedianDurationMs != nil || s.MedianFirstByteMs != nil {
		t.Fatalf("empty stats = %+v", s)
	}

	up.SetUsage(100, 10)
	slow(t, srv, up, alice, "gpt-x", 1*time.Second)
	slow(t, srv, up, alice, "gpt-x", 3*time.Second)
	slow(t, srv, up, alice, "gpt-y", 2*time.Second)
	slow(t, srv, up, bob, "gpt-x", 4*time.Second)
	up.Enqueue(up.Error(400, "bad messages"))
	bob.Post(chatPath, `{"model":"gpt-x","messages":[]}`).Expect(400)

	s := statsOf(t, srv, "")
	if s.Requests != 5 || s.Succeeded != 4 || s.Failed != 1 || s.InProgress != 0 || s.Retried != 0 {
		t.Fatalf("stats = %+v", s)
	}
	if s.MedianDurationMs == nil || *s.MedianDurationMs != 2500 || s.MedianFirstByteMs == nil || *s.MedianFirstByteMs != 2500 {
		t.Fatalf("medians = %v %v", s.MedianDurationMs, s.MedianFirstByteMs)
	}
	if s.Tokens.Input != 400 || s.Tokens.Output != 40 || s.Tokens.Total != 440 {
		t.Fatalf("tokens = %+v", s.Tokens)
	}

	for _, tc := range []struct {
		q        string
		n, ok    int
		medianMs int64
	}{
		{"caller=alice", 3, 3, 2000},
		{"caller=alice&model=gpt-x", 2, 2, 2000},
		{"model=gpt-x&model=gpt-y&caller=alice", 3, 3, 2000},
		{"caller=bob0", 2, 1, 4000},
		{"status=failed", 1, 0, 0},
		{"status=2xx", 4, 4, 2500},
		{"status=4xx&status=200", 5, 4, 2500},
		{"q=gpt-y", 1, 1, 2000},
		{"q=BOB0", 2, 1, 4000},
		{"provider=acme&since=1h", 5, 4, 2500},
	} {
		s := statsOf(t, srv, tc.q)
		if got := len(page(t, srv, tc.q).Requests); got != tc.n || s.Requests != tc.n || s.Succeeded != tc.ok {
			t.Errorf("%s: listed %d, stats %+v; want %d (%d succeeded)", tc.q, got, s, tc.n, tc.ok)
		}
		if tc.ok > 0 && (s.MedianDurationMs == nil || *s.MedianDurationMs != tc.medianMs) {
			t.Errorf("%s: median %v, want %d", tc.q, s.MedianDurationMs, tc.medianMs)
		}
	}
	srv.SkipShortWaits(time.Second)
	up.Enqueue(up.Error(500, "boom"), up.Text("ok"))
	alice.Post(chatPath, `{"model":"gpt-z","messages":[]}`).Expect(200)
	if s := statsOf(t, srv, "retried=true"); s.Requests != 1 || s.Retried != 1 || s.Succeeded != 1 {
		t.Fatalf("retried stats = %+v", s)
	}
	if s := statsOf(t, srv, ""); s.Retried != 1 || s.Requests != 6 {
		t.Fatalf("stats after a retry = %+v", s)
	}
	for _, q := range []string{"status=6xx", "retried=maybe", "caller_kind=robot", "since=yesterday"} {
		if e := srv.Admin.Get("/api/requests/stats?" + q).Expect(400).Err(); e.Hint == "" {
			t.Errorf("%s: no hint", q)
		}
	}
}

func insert(t *testing.T, srv *testkit.Server, id, kind, keyID, caller, model, pool string, status, attempts int) {
	t.Helper()
	_, err := srv.App.DB().Exec(`INSERT INTO requests (id, started_at, finished_at, state, status, caller_kind, gateway_key_id, caller_name, route, shape_in, model, pool, attempt_count, duration_ms)
		VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, '/v1/chat/completions', 'openai-chat', ?, ?, ?, 100)`,
		id, store.Millis(srv.Clock.Now()), store.Millis(srv.Clock.Now()), status, kind, keyID, caller, model, pool, attempts)
	if err != nil {
		t.Fatal(err)
	}
}

func TestRequestsFilterByTestCallersPoolsAndRetries(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, up.URL())
	alice, key := keyNamed(t, srv, "alice")
	alice.Post(chatPath, `{"model":"gpt-x","messages":[]}`).Expect(200)
	insert(t, srv, "req_test1", requests.CallerTest, key.ID, "Test (as alice)", "gpt-x", "", 200, 1)
	insert(t, srv, "req_test2", requests.CallerTest, "", "Test", "glm-4.6", "glm-4.6", 200, 3)
	insert(t, srv, "req_pool1", requests.CallerGatewayKey, key.ID, "alice", "glm-4.6", "glm-4.6", 502, 2)

	for _, tc := range []struct {
		q    string
		want int
	}{
		{"caller=" + key.ID, 2},
		{"caller=alice", 2},
		{"caller=" + url.QueryEscape("Test (as alice)"), 1},
		{"caller_kind=test", 2},
		{"caller_kind=gateway_key", 2},
		{"pool=glm-4.6", 2},
		{"pool=glm-4.6&caller_kind=test", 1},
		{"retried=true", 2},
		{"retried=false", 2},
		{"retried=true&status=failed", 1},
		{"q=test", 2},
	} {
		if got := page(t, srv, tc.q).Requests; len(got) != tc.want {
			t.Errorf("%s: %d Requests %v, want %d", tc.q, len(got), ids(got), tc.want)
		}
	}
	if r := request(t, srv, "req_pool1"); r.Pool != "glm-4.6" || r.Caller.Kind != requests.CallerGatewayKey {
		t.Fatalf("pool Request = %+v", r)
	}
	if s := statsOf(t, srv, ""); s.Retried != 2 || s.Requests != 4 || s.Failed != 1 {
		t.Fatalf("stats = %+v", s)
	}

	var opts requests.FilterOptions
	srv.Admin.Get("/api/requests/filters?since=1h").Expect(200).JSON(&opts)
	if len(opts.Callers) != 3 || opts.Callers[0].Name != "alice" || opts.Callers[0].Requests != 2 || opts.Callers[0].GatewayKeyID != key.ID {
		t.Fatalf("callers = %+v", opts.Callers)
	}
	for _, c := range opts.Callers[1:] {
		if c.Kind != requests.CallerTest || c.GatewayKeyID != "" {
			t.Errorf("test caller = %+v", c)
		}
	}
	if len(opts.Pools) != 1 || opts.Pools[0] != (requests.Option{Name: "glm-4.6", Requests: 2}) ||
		len(opts.Providers) != 1 || opts.Providers[0].Name != "acme" || len(opts.Models) != 2 || opts.Models[0].Requests != 2 {
		t.Fatalf("options = %+v", opts)
	}
	srv.Clock.Advance(2 * time.Hour)
	srv.Admin.Get("/api/requests/filters?since=1h").Expect(200).JSON(&opts)
	if len(opts.Callers)+len(opts.Providers)+len(opts.Pools)+len(opts.Models) != 0 {
		t.Fatalf("options outside the window = %+v", opts)
	}
}

func TestFollowingTheFeedReturnsOnlyWhatStartedOrChanged(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, up.URL())
	alice, _ := keyNamed(t, srv, "alice")
	bob, _ := keyNamed(t, srv, "bob")
	srv.Admin.Patch("/api/gateway-keys/alice", map[string]any{"capture": true}).Expect(200)

	first := alice.Post(chatPath, `{"model":"gpt-x","messages":[]}`).Expect(200).Header.Get("X-Request-Id")
	p := page(t, srv, "")
	if len(p.Requests) != 1 || p.Cursor == 0 {
		t.Fatalf("page = %+v", p)
	}
	cursor := p.Cursor
	if f := page(t, srv, fmt.Sprintf("changed_after=%d", cursor)); len(f.Requests) != 0 || f.Cursor != cursor {
		t.Fatalf("nothing changed, got %+v", f)
	}

	release := make(chan struct{})
	up.Enqueue(up.Text("late").HoldUntil(release))
	done := make(chan string)
	go func() {
		resp := bob.Open(http.MethodPost, chatPath, `{"model":"gpt-y","messages":[]}`)
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		done <- resp.Header.Get("X-Request-Id")
	}()
	up.Await(2)
	f := page(t, srv, fmt.Sprintf("changed_after=%d", cursor))
	if len(f.Requests) != 1 || f.Requests[0].State != requests.StateInProgress || f.Requests[0].Caller.Name != "bob" || f.Cursor <= cursor {
		t.Fatalf("in progress = %+v", f)
	}
	cursor = f.Cursor
	close(release)
	second := <-done
	f = page(t, srv, fmt.Sprintf("changed_after=%d", cursor))
	if len(f.Requests) != 1 || f.Requests[0].ID != second || f.Requests[0].State != requests.StateCompleted || f.Requests[0].Status != 200 {
		t.Fatalf("finished = %+v", f)
	}
	cursor = f.Cursor

	third := alice.Post(chatPath, `{"model":"gpt-x","messages":[]}`).Expect(200).Header.Get("X-Request-Id")
	if f := page(t, srv, fmt.Sprintf("changed_after=%d&caller=bob", cursor)); len(f.Requests) != 0 || f.Cursor <= cursor {
		t.Fatalf("filtered = %+v", f)
	}
	f = page(t, srv, "changed_after=0&limit=2")
	if len(f.Requests) != 2 || f.Requests[0].ID != first || f.Requests[1].ID != second {
		t.Fatalf("oldest changes first = %v", ids(f.Requests))
	}
	f = page(t, srv, fmt.Sprintf("changed_after=%d&limit=2", f.Cursor))
	if len(f.Requests) != 1 || f.Requests[0].ID != third || !f.Requests[0].Captured || f.NextBefore != "" {
		t.Fatalf("rest = %+v", f)
	}
	if e := srv.Admin.Get("/api/requests?changed_after=x").Expect(400).Err(); e.Hint == "" {
		t.Fatal("no hint")
	}
	srv.Admin.Get("/api/requests?changed_after=1&before=" + first).Expect(400)
}
