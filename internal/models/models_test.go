package models_test

import (
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/models"
	"github.com/hoangvu12/iroha/internal/testkit"
)

const chatPath = "/providers/acme/v1/chat/completions"

func chat(model string) map[string]any {
	return map[string]any{"model": model, "messages": []any{map[string]any{"role": "user", "content": "hi"}}}
}

// addProvider creates Provider acme with one OpenAI Chat Endpoint at url and
// an Upstream Key per secret; extra fields go into the Provider's create body.
func addProvider(t *testing.T, srv *testkit.Server, url string, extra map[string]any, secrets ...string) {
	t.Helper()
	body := map[string]any{"handle": "acme"}
	for k, v := range extra {
		body[k] = v
	}
	srv.Admin.Post("/api/providers", body).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"url": url, "shape": "openai-chat"}).Expect(201)
	for _, s := range secrets {
		srv.Admin.Post("/api/providers/acme/keys", map[string]any{"secret": s}).Expect(201)
	}
}

func issue(t *testing.T, srv *testkit.Server, name string, scope any) *testkit.Client {
	t.Helper()
	var out struct {
		GatewayKey struct{ Secret string } `json:"gateway_key"`
	}
	srv.Admin.Post("/api/gateway-keys", map[string]any{"name": name, "scope": scope}).Expect(201).JSON(&out)
	return srv.Client(out.GatewayKey.Secret)
}

var all = map[string]any{"all": true}

func refresh(t *testing.T, srv *testkit.Server) models.RefreshResult {
	t.Helper()
	var r models.RefreshResult
	srv.Admin.Post("/api/providers/acme/models/refresh", nil).Expect(200).JSON(&r)
	return r
}

func list(t *testing.T, srv *testkit.Server, query string) models.ModelList {
	t.Helper()
	var l models.ModelList
	srv.Admin.Get("/api/providers/acme/models?" + query).Expect(200).JSON(&l)
	return l
}

func names(l models.ModelList) string {
	var out []string
	for _, m := range l.Models {
		out = append(out, m.Model)
	}
	return strings.Join(out, ",")
}

func callerModels(t *testing.T, c *testkit.Client, handle string) string {
	t.Helper()
	var out models.CallerModelList
	c.Get("/providers/" + handle + "/v1/models").Expect(200).JSON(&out)
	var ids []string
	for _, m := range out.Data {
		if m.Object != "model" || m.OwnedBy != handle {
			t.Fatalf("caller model entry = %+v", m)
		}
		ids = append(ids, m.ID)
	}
	return strings.Join(ids, ",")
}

// inference counts the chat requests a fake received (not model lists).
func inference(up *testkit.Upstream) int {
	n := 0
	for _, r := range up.Requests() {
		if r.Method == http.MethodPost {
			n++
		}
	}
	return n
}

func TestDiscoveryFillsTheListAndCallersSeeIt(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	up.SetModels("gpt-b", "gpt-a", "gpt-a")
	addProvider(t, srv, up.URL(), nil, "sk-test-one")

	// Nothing is discovered until a refresh (or the daily job) runs.
	if l := list(t, srv, ""); len(l.Models) != 0 || l.Discovery != "provider" || l.Strict || l.LastRefresh != nil {
		t.Fatalf("list before refresh = %+v", l)
	}

	r := refresh(t, srv)
	if r.Outcome != "ok" || r.Discovered != 2 || strings.Join(r.Added, ",") != "gpt-a,gpt-b" || len(r.Lists) != 1 ||
		r.Lists[0].Endpoint != "default" || r.Lists[0].UpstreamKey != "key-1" || r.Lists[0].Found != 2 || r.Lists[0].URL != up.URL()+"/models" {
		t.Fatalf("refresh = %+v", r)
	}
	got := up.Last()
	if got.Method != "GET" || got.Path != "/v1/models" || got.Bearer() != "sk-test-one" {
		t.Fatalf("discovery request = %+v", got)
	}

	l := list(t, srv, "")
	if names(l) != "gpt-a,gpt-b" || l.LastRefresh == nil || l.LastRefresh.Outcome != "ok" || !l.LastRefresh.At.Equal(testkit.Epoch) {
		t.Fatalf("list = %+v", l)
	}
	m := l.Models[0]
	if !m.Discovered || !m.Visible || m.Added || m.Hidden || strings.Join(m.Endpoints, ",") != "default" || len(m.UpstreamKeys) != 0 || m.DiscoveredAt == nil {
		t.Fatalf("entry = %+v", m)
	}

	caller := issue(t, srv, "pi", all)
	if got := callerModels(t, caller, "acme"); got != "gpt-a,gpt-b" {
		t.Fatalf("caller list = %s", got)
	}

	ev := srv.Logs("kind=discovery&provider=acme")
	if len(ev) != 2 || ev[1].Attrs["endpoint"] != "default" || ev[1].Attrs["outcome"] != "ok" || ev[1].Attrs["found"] != float64(2) ||
		ev[0].Attrs["outcome"] != "ok" || ev[0].Attrs["added"] != float64(2) {
		t.Fatalf("discovery events = %+v", ev)
	}
}

func TestDiscoveryAcceptsModelsArraysCustomURLsAndNone(t *testing.T) {
	srv := testkit.Start(t)
	gem := testkit.NewGemini(t)
	gem.SetModels("gemini-2.5-pro", "gemini-2.5-flash")
	other := testkit.NewOpenAIChat(t)
	other.Handle("GET", "/plan/models", testkit.JSON(200, map[string]any{"models": []any{map[string]any{"model": "glm-4.6"}, "glm-4.5-air", map[string]any{"id": ""}}}))
	quiet := testkit.NewOpenAIChat(t)

	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": "gem", "url": gem.URL(), "shape": "gemini", "auth_style": "query", "auth_param": "key"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": "plan", "url": other.URL(), "shape": "openai-chat",
		"discovery_url": other.Origin() + "/plan/models"}).Expect(201)
	var ep struct {
		Endpoint struct {
			DiscoveryURL string `json:"discovery_url"`
		} `json:"endpoint"`
	}
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": "quiet", "url": quiet.URL(), "shape": "openai-chat", "discovery_url": "none"}).
		Expect(201).JSON(&ep)
	if ep.Endpoint.DiscoveryURL != "none" {
		t.Fatalf("discovery_url = %q", ep.Endpoint.DiscoveryURL)
	}
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": "bad", "url": quiet.URL(), "shape": "openai-chat", "discovery_url": "ftp://x"}).Expect(400)
	srv.Admin.Post("/api/providers/acme/keys", map[string]any{"secret": "sk-test-g"}).Expect(201)

	r := refresh(t, srv)
	if r.Outcome != "ok" || len(r.Lists) != 2 || strings.Join(r.Added, ",") != "gemini-2.5-flash,gemini-2.5-pro,glm-4.5-air,glm-4.6" {
		t.Fatalf("refresh = %+v", r)
	}
	if g := gem.Last(); g.Path != "/v1beta/models" || g.Query.Get("key") != "sk-test-g" || g.Header.Get("Authorization") != "" {
		t.Fatalf("gemini discovery = %+v", g)
	}
	if o := other.Last(); o.Path != "/plan/models" || o.Bearer() != "sk-test-g" {
		t.Fatalf("custom discovery = %+v", o)
	}
	if quiet.Count() != 0 {
		t.Fatalf("an Endpoint with discovery_url none was asked")
	}
	l := list(t, srv, "q=glm")
	if names(l) != "glm-4.5-air,glm-4.6" || strings.Join(l.Models[0].Endpoints, ",") != "plan" {
		t.Fatalf("list = %+v", l)
	}

	// Discovery none: nothing is read and the list stays as it is.
	srv.Admin.Patch("/api/providers/acme", map[string]any{"discovery": "none"}).Expect(200)
	if r := refresh(t, srv); r.Outcome != "skipped" || !strings.Contains(r.Summary, "off") {
		t.Fatalf("refresh with discovery none = %+v", r)
	}
	if l := list(t, srv, ""); l.Counts.All != 4 {
		t.Fatalf("list after a skipped refresh = %+v", l.Counts)
	}
	srv.Admin.Patch("/api/providers/acme", map[string]any{"discovery": "sometimes"}).Expect(400)
}

func TestDiscoveryFollowsPagesAndSendsTheEndpointsAuth(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewAnthropic(t)
	up.Handle("GET", "/v1/models", func(r *testkit.Received) testkit.Reply {
		if r.Query.Get("after_id") == "" {
			return testkit.JSON(200, map[string]any{"data": []any{map[string]any{"id": "claude-a"}}, "has_more": true, "last_id": "claude-a"})(r)
		}
		return testkit.JSON(200, map[string]any{"data": []any{map[string]any{"id": "claude-b"}}, "has_more": false})(r)
	})
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"url": up.URL(), "shape": "anthropic-messages", "auth_style": "x-api-key",
		"static_headers": map[string]string{"X-Team": "t1"}}).Expect(201)
	srv.Admin.Post("/api/providers/acme/keys", map[string]any{"secret": "sk-test-ant"}).Expect(201)

	if r := refresh(t, srv); r.Outcome != "ok" || r.Discovered != 2 || r.Lists[0].Found != 2 {
		t.Fatalf("refresh = %+v", r)
	}
	reqs := up.Requests()
	if len(reqs) != 2 || reqs[1].Query.Get("after_id") != "claude-a" {
		t.Fatalf("pages = %+v", reqs)
	}
	h := reqs[0].Header
	if h.Get("X-Api-Key") != "sk-test-ant" || h.Get("Authorization") != "" || h.Get("Anthropic-Version") == "" || h.Get("X-Team") != "t1" {
		t.Fatalf("discovery headers = %v", h)
	}
}

func TestFailedDiscoveryKeepsThePreviousListAndIsLogged(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	up.SetModels("m1", "m2")
	addProvider(t, srv, up.URL(), nil, "sk-test-one")
	refresh(t, srv)

	for _, bad := range []testkit.Responder{
		up.Error(500, "boom"),
		testkit.Raw(200, "text/html", "<html>maintenance</html>"),
		testkit.JSON(200, map[string]any{"object": "list"}),
	} {
		up.Handle("GET", "/v1/models", bad)
		r := refresh(t, srv)
		if r.Outcome != "failed" || r.Lists[0].Outcome != "failed" || r.Lists[0].Error == "" || len(r.Removed) != 0 || r.Discovered != 2 {
			t.Fatalf("failed refresh = %+v", r)
		}
		if l := list(t, srv, ""); names(l) != "m1,m2" || l.LastRefresh.Outcome != "failed" {
			t.Fatalf("list after a failed refresh = %+v", l)
		}
	}
	ev := srv.Logs("kind=discovery&level=warn")
	if len(ev) != 6 || ev[1].Attrs["outcome"] != "failed" || !strings.Contains(fmt.Sprint(ev[1].Attrs["error"]), "no data or models array") {
		t.Fatalf("warn events = %+v", ev)
	}
	if !strings.Contains(fmt.Sprint(srv.Logs("kind=discovery&level=warn")[5].Attrs["error"]), "HTTP 500") {
		t.Fatalf("first failure not logged with its status")
	}

	// A list that no longer names a model drops it.
	up.Handle("GET", "/v1/models", testkit.JSON(200, map[string]any{"data": []any{map[string]any{"id": "m2"}}}))
	if r := refresh(t, srv); r.Outcome != "ok" || strings.Join(r.Removed, ",") != "m1" {
		t.Fatalf("refresh = %+v", r)
	}
	if l := list(t, srv, ""); names(l) != "m2" {
		t.Fatalf("list = %s", names(l))
	}
}

func TestOwnerAdditionsSurviveRefreshesAndAreAudited(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	up.SetModels("m1")
	addProvider(t, srv, up.URL(), nil, "sk-test-one")
	refresh(t, srv)

	var res models.ModelResult
	srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": "secret-model"}).Expect(201).JSON(&res)
	if res.Outcome != "created" || res.AuditEntry == "" || !res.Model.Added || !res.Model.Visible || res.Model.Discovered {
		t.Fatalf("add = %+v", res)
	}
	res = models.ModelResult{}
	srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": "secret-model"}).Expect(200).JSON(&res)
	if res.Outcome != "unchanged" || res.AuditEntry != "" {
		t.Fatalf("second add = %+v", res)
	}
	// Adding a discovered model marks it too, so it outlives discovery.
	srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": "m1", "added": true}).Expect(201)

	up.SetModels("m9")
	r := refresh(t, srv)
	if strings.Join(r.Removed, ",") != "m1" {
		t.Fatalf("refresh = %+v", r)
	}
	l := list(t, srv, "")
	if names(l) != "m1,m9,secret-model" || l.Counts.Added != 2 || l.Counts.Discovered != 1 || l.Models[0].Discovered || !l.Models[0].Visible {
		t.Fatalf("list = %+v", l)
	}
	if got := callerModels(t, issue(t, srv, "pi", all), "acme"); got != "m1,m9,secret-model" {
		t.Fatalf("caller list = %s", got)
	}

	// Reverting the addition takes the model off again; revert of a revert puts it back.
	var page audit.EntryPage
	srv.Admin.Get("/api/audit-entries?record=acme/secret-model").Expect(200).JSON(&page)
	if len(page.Entries) != 1 || page.Entries[0].Action != "model.change" || page.Entries[0].Changes[0].Resource != "model" {
		t.Fatalf("entries = %+v", page)
	}
	srv.Admin.Post("/api/audit-entries/"+page.Entries[0].ID+"/revert", nil).Expect(200)
	if l := list(t, srv, ""); names(l) != "m1,m9" {
		t.Fatalf("list after revert = %s", names(l))
	}

	// Taking an addition off a model discovery does not find deletes it.
	srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": "m1", "added": false}).Expect(200).JSON(&res)
	if res.Outcome != "deleted" || res.Model.Added || res.Model.Visible {
		t.Fatalf("remove = %+v", res)
	}
	if l := list(t, srv, ""); names(l) != "m9" {
		t.Fatalf("list = %s", names(l))
	}
	// MOD-61: taking an addition off a model discovery still finds keeps it,
	// visible and discovered.
	srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": "m9", "added": true}).Expect(201)
	res = models.ModelResult{}
	srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": "m9", "added": false}).Expect(200).JSON(&res)
	if res.Outcome != "deleted" || res.AuditEntry == "" || res.Model.Added || !res.Model.Visible || !res.Model.Discovered {
		t.Fatalf("remove from a discovered model = %+v", res)
	}
	if l := list(t, srv, ""); names(l) != "m9" || !l.Models[0].Visible || l.Counts.Added != 0 {
		t.Fatalf("list = %+v", l)
	}
	srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": " padded "}).Expect(400)
}

func TestHiddenModelsAreRefusedAndUnlisted(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	up.SetModels("m1", "m2")
	addProvider(t, srv, up.URL(), nil, "sk-test-one")
	refresh(t, srv)
	caller := issue(t, srv, "pi", all)

	var bulk struct {
		Succeeded int
		Failed    int
	}
	srv.Admin.Post("/api/providers/acme/models/bulk", map[string]any{"items": []any{
		map[string]any{"model": "m2", "hidden": true},
		map[string]any{"model": "never-seen", "hidden": true},
		map[string]any{"model": ""},
	}}).Expect(200).JSON(&bulk)
	if bulk.Succeeded != 2 || bulk.Failed != 1 {
		t.Fatalf("bulk = %+v", bulk)
	}
	if got := callerModels(t, caller, "acme"); got != "m1" {
		t.Fatalf("caller list = %s", got)
	}
	l := list(t, srv, "filter=hidden")
	if names(l) != "m2,never-seen" || l.Models[0].Visible || !l.Models[0].Discovered || l.Counts.Hidden != 2 || l.Counts.Visible != 1 {
		t.Fatalf("hidden list = %+v", l)
	}

	for _, model := range []string{"m2", "never-seen"} {
		e := caller.Post(chatPath, chat(model)).Expect(404).Err()
		if e.Code != "model_not_found" || !strings.Contains(e.Hint, "/providers/acme/v1/models") {
			t.Fatalf("refusal = %+v", e)
		}
	}
	if n := inference(up); n != 0 {
		t.Fatalf("a hidden model reached the upstream (%d chat requests)", n)
	}
	caller.Post(chatPath, chat("m1")).Expect(200)

	// Hidden survives refreshes; showing it again lets it through.
	refresh(t, srv)
	caller.Post(chatPath, chat("m2")).Expect(404)
	srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": "m2", "hidden": false}).Expect(200)
	caller.Post(chatPath, chat("m2")).Expect(200)
	if got := callerModels(t, caller, "acme"); got != "m1,m2" {
		t.Fatalf("caller list = %s", got)
	}
}

func TestStrictProvidersRefuseUnlistedModelsOthersForwardThem(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	up.SetModels("listed")
	addProvider(t, srv, up.URL(), nil, "sk-test-one")
	refresh(t, srv)
	caller := issue(t, srv, "pi", all)

	// Not strict (the default): an unlisted model is forwarded.
	caller.Post(chatPath, chat("aggregator/alias")).Expect(200)
	if up.Last().Model != "aggregator/alias" {
		t.Fatalf("unlisted model not forwarded")
	}

	var p struct {
		Provider struct{ Strict bool } `json:"provider"`
	}
	srv.Admin.Patch("/api/providers/acme", map[string]any{"strict": true}).Expect(200).JSON(&p)
	if !p.Provider.Strict {
		t.Fatalf("strict not set")
	}
	before := inference(up)
	e := caller.Post(chatPath, chat("typo-model")).Expect(404).Err()
	if e.Code != "model_not_found" {
		t.Fatalf("refusal = %+v", e)
	}
	if inference(up) != before {
		t.Fatalf("a strict Provider made an Attempt for an unlisted model")
	}
	caller.Post(chatPath, chat("listed")).Expect(200)

	// Owner additions and Endpoint renames name models on purpose.
	srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": "hand-added"}).Expect(201)
	caller.Post(chatPath, chat("hand-added")).Expect(200)
	srv.Admin.Patch("/api/providers/acme/endpoints/default", map[string]any{"renames": map[string]string{"nice-name": "listed"}}).Expect(200)
	caller.Post(chatPath, chat("nice-name")).Expect(200)
	if up.Last().Model != "listed" {
		t.Fatalf("rename not applied")
	}
}

// perKey answers GET /v1/models with a list per key (by bearer).
type perKey struct {
	mu    sync.Mutex
	lists map[string][]string
}

func (p *perKey) set(bearer string, models ...string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.lists[bearer] = models
}

func servePerKey(up *testkit.Upstream) *perKey {
	p := &perKey{lists: map[string][]string{}}
	up.Handle("GET", "/v1/models", func(r *testkit.Received) testkit.Reply {
		p.mu.Lock()
		ids, ok := p.lists[r.Bearer()]
		p.mu.Unlock()
		if !ok {
			return up.Error(401, "bad key")(r)
		}
		data := []any{}
		for _, id := range ids {
			data = append(data, map[string]any{"id": id})
		}
		return testkit.JSON(200, map[string]any{"data": data})(r)
	})
	return p
}

func bearersOf(up *testkit.Upstream, from int) string {
	var out []string
	for _, r := range up.Requests()[from:] {
		if r.Method == http.MethodPost {
			out = append(out, strings.TrimPrefix(r.Bearer(), "sk-test-"))
		}
	}
	return strings.Join(out, ",")
}

func TestPerKeyListsPutCarriersFirstAndClearModelGaps(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	lists := servePerKey(up)
	lists.set("sk-test-a", "small")
	lists.set("sk-test-b", "small", "big")
	addProvider(t, srv, up.URL(), map[string]any{"discovery": "key"}, "sk-test-a", "sk-test-b", "sk-test-c")
	caller := issue(t, srv, "pi", all)

	r := refresh(t, srv)
	if r.Outcome != "partial" || len(r.Lists) != 3 || r.Discovered != 2 || !strings.Contains(r.Summary, "key-3") {
		t.Fatalf("refresh = %+v", r)
	}
	l := list(t, srv, "q=big")
	if names(l) != "big" || strings.Join(l.Models[0].UpstreamKeys, ",") != "key-2" {
		t.Fatalf("list = %+v", l)
	}

	// Whatever the rotation, the carrier of big goes first; the other keys
	// still follow (a list never excludes a key).
	up.Default(func(r *testkit.Received) testkit.Reply { return up.Error(503, "busy")(r) })
	for i := 0; i < 3; i++ {
		from := len(up.Requests())
		caller.Post(chatPath, chat("big")).Expect(502)
		if got := bearersOf(up, from); !strings.HasPrefix(got, "b,") || len(strings.Split(got, ",")) != 3 {
			t.Fatalf("round %d: keys tried = %s", i, got)
		}
	}

	// key-1 is refused big (a Model Gap); once its own list names big, the
	// next refresh clears the gap.
	up.Default(func(r *testkit.Received) testkit.Reply {
		if r.Bearer() == "sk-test-a" && r.Model == "big" {
			return up.ErrorCode(404, "model_not_found", "The model big does not exist.")(r)
		}
		return up.Text("hi")(r)
	})
	srv.Admin.Patch("/api/providers/acme/keys/key-2", map[string]any{"enabled": false}).Expect(200)
	srv.Admin.Patch("/api/providers/acme/keys/key-3", map[string]any{"enabled": false}).Expect(200)
	caller.Post(chatPath, chat("big")).Expect(404)
	if l := list(t, srv, "filter=gaps"); names(l) != "big" || strings.Join(l.Models[0].ModelGaps, ",") != "key-1" || l.Counts.Gaps != 1 {
		t.Fatalf("gaps list = %+v", l)
	}
	lists.set("sk-test-a", "small", "big")
	r = refresh(t, srv)
	if r.GapsCleared != 1 {
		t.Fatalf("refresh = %+v", r)
	}
	ev := srv.Logs("kind=model_gap&provider=acme")
	if len(ev) < 2 || ev[0].Attrs["op"] != "cleared" || ev[0].Attrs["upstream_key"] != "key-1" || !strings.Contains(fmt.Sprint(ev[0].Attrs["reason"]), "discovered model list") {
		t.Fatalf("model_gap events = %+v", ev)
	}
	if l := list(t, srv, "filter=gaps"); l.Total != 0 {
		t.Fatalf("gap still listed: %+v", l)
	}
	// Disabled keys' lists are kept (not read, not dropped).
	if l := list(t, srv, "q=big"); strings.Join(l.Models[0].UpstreamKeys, ",") != "key-1,key-2" {
		t.Fatalf("carriers = %+v", l.Models[0])
	}

	// Switching to per-Provider discovery drops the per-key lists at the next refresh.
	srv.Admin.Patch("/api/providers/acme", map[string]any{"discovery": "provider"}).Expect(200)
	refresh(t, srv)
	if l := list(t, srv, ""); names(l) != "big,small" || len(l.Models[0].UpstreamKeys) != 0 {
		t.Fatalf("list after mode switch = %+v", l)
	}
}

func TestResetForgetsDiscoveredModelsButKeepsTheProvider(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	up.SetModels("junk-1", "junk-2", "good")
	addProvider(t, srv, up.URL(), nil, "sk-test-one")
	refresh(t, srv)
	srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": "good"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": "junk-2", "hidden": true}).Expect(201)
	caller := issue(t, srv, "pi", map[string]any{"providers": []any{map[string]any{"provider": "acme"}}})

	var dry models.ResetResult
	srv.Admin.Post("/api/providers/acme/models/reset?dry_run=true", nil).Expect(200).JSON(&dry)
	if !dry.DryRun || strings.Join(dry.Removed, ",") != "junk-1" || dry.Kept != 2 {
		t.Fatalf("dry reset = %+v", dry)
	}
	if l := list(t, srv, ""); l.Counts.Discovered != 3 {
		t.Fatalf("a dry run changed the list: %+v", l.Counts)
	}
	var res models.ResetResult
	srv.Admin.Post("/api/providers/acme/models/reset", nil).Expect(200).JSON(&res)
	if strings.Join(res.Removed, ",") != "junk-1" || res.Kept != 2 {
		t.Fatalf("reset = %+v", res)
	}
	l := list(t, srv, "")
	if names(l) != "good,junk-2" || l.Counts.Discovered != 0 || l.LastRefresh != nil {
		t.Fatalf("list after reset = %+v", l)
	}
	if got := callerModels(t, caller, "acme"); got != "good" {
		t.Fatalf("caller list = %s", got)
	}
	caller.Post(chatPath, chat("good")).Expect(200)

	up.SetModels("good", "fresh")
	if r := refresh(t, srv); strings.Join(r.Added, ",") != "fresh,good" {
		t.Fatalf("refresh after reset = %+v", r)
	}
}

func TestDryRunRefreshSendsNothing(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	up.SetModels("m1")
	addProvider(t, srv, up.URL(), map[string]any{"discovery": "key"}, "sk-test-a", "sk-test-b")
	var r models.RefreshResult
	srv.Admin.Post("/api/providers/acme/models/refresh?dry_run=true", nil).Expect(200).JSON(&r)
	if !r.DryRun || len(r.Lists) != 2 || r.Lists[0].Outcome != "planned" || r.Lists[1].UpstreamKey != "key-2" {
		t.Fatalf("dry refresh = %+v", r)
	}
	if up.Count() != 0 || len(srv.Logs("kind=discovery")) != 0 {
		t.Fatalf("a dry run sent or logged something")
	}
	srv.Admin.Post("/api/providers/nope/models/refresh", nil).Expect(404)
}

func TestModelListSearchFilterAndPaging(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	var ids []string
	for i := 0; i < 250; i++ {
		ids = append(ids, fmt.Sprintf("model-%03d", i))
	}
	up.SetModels(ids...)
	addProvider(t, srv, up.URL(), nil, "sk-test-one")
	refresh(t, srv)

	l := list(t, srv, "")
	if l.Total != 250 || l.Limit != 100 || len(l.Models) != 100 || l.Models[0].Model != "model-000" || l.Counts.All != 250 {
		t.Fatalf("first page = total %d limit %d len %d", l.Total, l.Limit, len(l.Models))
	}
	l = list(t, srv, "offset=200&limit=100")
	if len(l.Models) != 50 || l.Models[0].Model != "model-200" {
		t.Fatalf("last page = %d from %s", len(l.Models), l.Models[0].Model)
	}
	l = list(t, srv, "q=MODEL-24&limit=5")
	if l.Total != 10 || names(l) != "model-240,model-241,model-242,model-243,model-244" || l.Counts.All != 250 {
		t.Fatalf("search = %+v", names(l))
	}
	if l := list(t, srv, "offset=900"); len(l.Models) != 0 || l.Total != 250 {
		t.Fatalf("past the end = %+v", l.Total)
	}
	srv.Admin.Get("/api/providers/acme/models?limit=0").Expect(400)
	srv.Admin.Get("/api/providers/acme/models?filter=odd").Expect(400)
}

func TestCallerModelListFollowsTheGatewayKeyScope(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	up.SetModels("m1", "m2")
	addProvider(t, srv, up.URL(), nil, "sk-test-one")
	refresh(t, srv)
	srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": "m2", "hidden": true}).Expect(201)
	srv.Admin.Post("/api/providers", map[string]any{"handle": "other"}).Expect(201)

	narrow := issue(t, srv, "narrow", map[string]any{"providers": []any{map[string]any{"provider": "acme", "models": []string{"zz-unknown", "m1", "m2"}}}})
	if got := callerModels(t, narrow, "acme"); got != "m1,zz-unknown" {
		t.Fatalf("narrow list = %s", got)
	}
	if e := narrow.Get("/providers/other/v1/models").Expect(403).Err(); e.Code != "provider_not_allowed" {
		t.Fatalf("out of scope = %+v", e)
	}
	narrow.Get("/providers/nope/v1/models").Expect(403)
	srv.Anon.Get("/providers/acme/v1/models").Expect(401)
	srv.Client("sk-iroha_wrong").Get("/providers/acme/v1/models").Expect(401)

	wide := issue(t, srv, "wide", all)
	srv.Admin.Patch("/api/providers/acme", map[string]any{"enabled": false}).Expect(200)
	wide.Get("/providers/acme/v1/models").Expect(403)
}
