package models_test

import (
	"net/http"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/models"
	"github.com/hoangvu12/iroha/internal/testkit"
)

// c26Keys answers GET /v1/models per bearer: a list of items (strings or
// model objects), a failure status, or 401 for an unknown key.
type c26Keys struct {
	mu   sync.Mutex
	list map[string][]any
	fail map[string]int
}

func c26ServeKeys(up *testkit.Upstream) *c26Keys {
	k := &c26Keys{list: map[string][]any{}, fail: map[string]int{}}
	up.Handle(http.MethodGet, "/v1/models", func(r *testkit.Received) testkit.Reply {
		k.mu.Lock()
		items, ok := k.list[r.Bearer()]
		status := k.fail[r.Bearer()]
		k.mu.Unlock()
		switch {
		case status != 0:
			return up.Error(status, "boom")(r)
		case !ok:
			return up.Error(401, "bad key")(r)
		}
		data := []any{}
		for _, it := range items {
			if s, ok := it.(string); ok {
				it = map[string]any{"id": s}
			}
			data = append(data, it)
		}
		return testkit.JSON(200, map[string]any{"data": data})(r)
	})
	return k
}

func (k *c26Keys) set(bearer string, items ...any) {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.list[bearer] = items
}

// failWith makes bearer's list answer status (0: answer again).
func (k *c26Keys) failWith(bearer string, status int) {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.fail[bearer] = status
}

// c26ListReads names (by secret, without sk-test-) the keys of the model
// list reads a fake received from request number from on.
func c26ListReads(up *testkit.Upstream, from int) string {
	var out []string
	for _, r := range up.Requests()[from:] {
		if r.Method == http.MethodGet {
			out = append(out, strings.TrimPrefix(r.Bearer(), "sk-test-"))
		}
	}
	return strings.Join(out, ",")
}

// MOD-69: a list naming a model without metadata keeps the facts reported
// before; with several keys (discovery: key) the first answering key's
// object wins for each model.
func TestAListEntryWithoutMetadataKeepsTheLastReportedFactsAndTheFirstAnsweringKeyWins(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	lists := c26ServeKeys(up)
	lists.set("sk-test-one", map[string]any{"id": "m1", "object": "model", "context_length": 1000000})
	addProvider(t, srv, up.URL(), nil, "sk-test-one", "sk-test-two")
	caller := issue(t, srv, "pi", all)
	context := func(model string) int64 {
		t.Helper()
		c := callerList(t, caller, "acme")[model].ContextLength
		if c == nil {
			return 0
		}
		return *c
	}

	refresh(t, srv)
	if c := context("m1"); c != 1000000 {
		t.Fatalf("m1 context = %d", c)
	}
	// The same model listed bare: the facts stay.
	lists.set("sk-test-one", map[string]any{"id": "m1", "object": "model"})
	if r := refresh(t, srv); r.Outcome != "ok" || r.Discovered != 1 {
		t.Fatalf("refresh = %+v", r)
	}
	if c := context("m1"); c != 1000000 {
		t.Fatalf("m1 context after a bare entry = %d", c)
	}
	if l := list(t, srv, "q=m1"); l.Models[0].Reported.ContextLength == nil || *l.Models[0].Reported.ContextLength != 1000000 {
		t.Fatalf("reported after a bare entry = %+v", l.Models[0].Reported)
	}
	// New facts replace the old ones.
	lists.set("sk-test-one", map[string]any{"id": "m1", "context_length": 2000})
	refresh(t, srv)
	if c := context("m1"); c != 2000 {
		t.Fatalf("m1 context after new facts = %d", c)
	}

	// Per-key lists: each key reports its own object; the first key's wins.
	srv.Admin.Patch("/api/providers/acme", map[string]any{"discovery": "key"}).Expect(200)
	lists.set("sk-test-one", map[string]any{"id": "m2", "context_length": 111}, "m1")
	lists.set("sk-test-two", map[string]any{"id": "m2", "context_length": 222}, map[string]any{"id": "m1", "context_length": 999})
	if r := refresh(t, srv); r.Outcome != "ok" || len(r.Lists) != 2 {
		t.Fatalf("per-key refresh = %+v", r)
	}
	// key-1 lists m1 bare: key-2's object is the first that says something of it.
	if c2, c1 := context("m2"), context("m1"); c2 != 111 || c1 != 999 {
		t.Fatalf("contexts m2 %d, m1 %d", c2, c1)
	}
	// key-1's list fails: key-2 is the first answering key.
	lists.failWith("sk-test-one", 500)
	if r := refresh(t, srv); r.Outcome != "partial" {
		t.Fatalf("refresh = %+v", r)
	}
	if c := context("m2"); c != 222 {
		t.Fatalf("m2 context with key-1 failing = %d", c)
	}
	lists.failWith("sk-test-one", 0)
	refresh(t, srv)
	if c := context("m2"); c != 111 {
		t.Fatalf("m2 context with key-1 back = %d", c)
	}
}

// USE-22: a model list failure whose body echoes the key's secret never puts
// the secret in the refresh result, the discovery events or the console.
func TestAModelListEchoingTheKeyNeverPutsTheSecretInResultsLogsOrTheConsole(t *testing.T) {
	const secret = "sk-test-echo-0123456789abcdef"
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	up.Handle(http.MethodGet, "/v1/models", func(r *testkit.Received) testkit.Reply {
		return up.ErrorCode(401, "invalid_api_key", "Incorrect API key provided: "+r.Bearer()+". Find your key at https://example.com/keys?k="+r.Bearer())(r)
	})
	addProvider(t, srv, up.URL(), nil, secret)

	resp := srv.Admin.Post("/api/providers/acme/models/refresh", nil).Expect(200)
	var r models.RefreshResult
	resp.JSON(&r)
	if r.Outcome != "failed" || r.Lists[0].Status != 401 || !strings.Contains(r.Lists[0].Error, "HTTP 401") ||
		!strings.Contains(r.Lists[0].Error, "Incorrect API key provided: ***") {
		t.Fatalf("refresh = %+v", r)
	}
	if strings.Contains(resp.Text(), secret) {
		t.Fatalf("the refresh result holds the secret: %s", resp.Text())
	}
	if l := srv.Admin.Get("/api/providers/acme/models").Expect(200).Text(); strings.Contains(l, secret) {
		t.Fatalf("the model list's last refresh holds the secret: %s", l)
	}
	ev := srv.Admin.Get("/api/logs?kind=discovery&limit=100").Expect(200).Text()
	if strings.Contains(ev, secret) || !strings.Contains(ev, "***") {
		t.Fatalf("discovery events = %s", ev)
	}
	if strings.Contains(srv.Console(), secret) {
		t.Fatal("the console holds the secret")
	}
}

// MOD-32: under per-key discovery a key whose list fails keeps the list it
// read before, and so stays first for the models it carries.
func TestAKeysFailedRediscoveryKeepsItsListAndItsPlaceFirst(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	lists := c26ServeKeys(up)
	lists.set("sk-test-a", "small")
	lists.set("sk-test-b", "small", "big")
	addProvider(t, srv, up.URL(), map[string]any{"discovery": "key"}, "sk-test-a", "sk-test-b", "sk-test-c")
	lists.set("sk-test-c", "small")
	caller := issue(t, srv, "pi", all)
	if r := refresh(t, srv); r.Outcome != "ok" {
		t.Fatalf("refresh = %+v", r)
	}

	lists.failWith("sk-test-b", 500)
	r := refresh(t, srv)
	if r.Outcome != "partial" || r.Discovered != 2 || len(r.Removed) != 0 || r.Lists[1].UpstreamKey != "key-2" || r.Lists[1].Outcome != "failed" {
		t.Fatalf("refresh with key-2 failing = %+v", r)
	}
	if l := list(t, srv, "q=big"); names(l) != "big" || strings.Join(l.Models[0].UpstreamKeys, ",") != "key-2" || !l.Models[0].Visible {
		t.Fatalf("big after key-2's list failed = %+v", l)
	}
	up.Default(func(r *testkit.Received) testkit.Reply { return up.Error(503, "busy")(r) })
	for i := 0; i < 3; i++ {
		from := len(up.Requests())
		caller.Post(chatPath, chat("big")).Expect(502)
		if got := bearersOf(up, from); !strings.HasPrefix(got, "b,") || len(strings.Split(got, ",")) != 3 {
			t.Fatalf("round %d: keys tried = %s", i, got)
		}
	}
}

// MOD-34, MOD-49, PRV-69: per-Provider discovery reads each Endpoint's list
// once, with the first key; when that key's list is refused it reads with
// the next key; with every key disabled nothing is read.
func TestPerProviderDiscoveryReadsOnceWithTheFirstKeyThenTheNext(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	lists := c26ServeKeys(up)
	for _, s := range []string{"sk-test-a", "sk-test-b", "sk-test-c"} {
		lists.set(s, "m1")
	}
	addProvider(t, srv, up.URL(), nil, "sk-test-a", "sk-test-b", "sk-test-c")

	r := refresh(t, srv)
	if r.Outcome != "ok" || r.Discovery != "provider" || len(r.Lists) != 1 || r.Lists[0].UpstreamKey != "key-1" {
		t.Fatalf("refresh = %+v", r)
	}
	if got := c26ListReads(up, 0); got != "a" {
		t.Fatalf("list reads = %s, want one with key-1", got)
	}

	lists.failWith("sk-test-a", 401)
	from := len(up.Requests())
	r = refresh(t, srv)
	if r.Outcome != "ok" || len(r.Lists) != 1 || r.Lists[0].UpstreamKey != "key-2" || r.Lists[0].Outcome != "ok" || r.Discovered != 1 {
		t.Fatalf("refresh with key-1 refused = %+v", r)
	}
	if got := c26ListReads(up, from); got != "a,b" {
		t.Fatalf("list reads = %s, want key-1 then key-2", got)
	}

	for _, k := range []string{"key-1", "key-2", "key-3"} {
		srv.Admin.Patch("/api/providers/acme/keys/"+k, map[string]any{"enabled": false}).Expect(200)
	}
	from = len(up.Requests())
	r = refresh(t, srv)
	if r.Outcome != "skipped" || !strings.Contains(r.Summary, "every key is disabled") || len(r.Lists) != 0 {
		t.Fatalf("refresh with every key disabled = %+v", r)
	}
	if got := c26ListReads(up, from); got != "" {
		t.Fatalf("list reads with every key disabled = %s", got)
	}
	if l := list(t, srv, ""); names(l) != "m1" {
		t.Fatalf("list after a skipped refresh = %s", names(l))
	}
}

// MOD-39: an Endpoint without a key, or with a keyless slot, is read with
// no credential at all, whatever its auth style.
func TestKeylessDiscoverySendsNoCredential(t *testing.T) {
	srv := testkit.Start(t)
	plain := testkit.NewOpenAIChat(t)
	plain.SetModels("free-1")
	xkey := testkit.NewOpenAIChat(t)
	xkey.SetModels("free-2")
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": "plain", "url": plain.URL(), "shape": "openai-chat"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": "xkey", "url": xkey.URL(), "shape": "openai-chat", "auth_style": "x-api-key"}).Expect(201)
	noCredential := func(when string) {
		t.Helper()
		for _, up := range []*testkit.Upstream{plain, xkey} {
			h := up.Last().Header
			if h.Get("Authorization") != "" || h.Get("X-Api-Key") != "" || len(up.Last().Query) != 0 {
				t.Fatalf("%s: discovery sent a credential: %v", when, h)
			}
		}
	}

	r := refresh(t, srv)
	if r.Outcome != "ok" || r.Discovered != 2 || r.Lists[0].UpstreamKey != "" || r.Lists[1].UpstreamKey != "" {
		t.Fatalf("refresh without a key = %+v", r)
	}
	noCredential("no key")

	srv.Admin.Post("/api/providers/acme/keys", map[string]any{"name": "free"}).Expect(201)
	r = refresh(t, srv)
	if r.Outcome != "ok" || r.Lists[0].UpstreamKey != "free" || r.Lists[1].UpstreamKey != "free" {
		t.Fatalf("refresh with a keyless slot = %+v", r)
	}
	if plain.Count() != 2 || xkey.Count() != 2 {
		t.Fatalf("list reads: plain %d, xkey %d", plain.Count(), xkey.Count())
	}
	noCredential("keyless slot")
}

// PRV-02: under per-key discovery a key restricted to some Endpoints never
// reads the other Endpoints' lists.
func TestARestrictedKeyNeverReadsOtherEndpointsLists(t *testing.T) {
	srv := testkit.Start(t)
	a := testkit.NewOpenAIChat(t)
	a.SetModels("from-a")
	b := testkit.NewOpenAIChat(t)
	b.SetModels("from-b")
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme", "discovery": "key"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": "a", "url": a.URL(), "shape": "openai-chat"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": "b", "url": b.URL(), "shape": "openai-chat"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/keys", map[string]any{"secret": "sk-test-one", "endpoints": []string{"a"}}).Expect(201)
	srv.Admin.Post("/api/providers/acme/keys", map[string]any{"secret": "sk-test-two"}).Expect(201)

	r := refresh(t, srv)
	if r.Outcome != "ok" || len(r.Lists) != 3 {
		t.Fatalf("refresh = %+v", r)
	}
	if got := c26ListReads(b, 0); got != "two" {
		t.Fatalf("Endpoint b's list was read with %q, want only key-2", got)
	}
	if got := c26ListReads(a, 0); got != "one,two" && got != "two,one" {
		t.Fatalf("Endpoint a's list was read with %q", got)
	}
	if l := list(t, srv, "q=from-b"); strings.Join(l.Models[0].UpstreamKeys, ",") != "key-2" {
		t.Fatalf("from-b = %+v", l.Models[0])
	}
}

// MOD-65: an archived Provider's models are refused and left out of the
// global list; the Owner may still edit its model list (deviation).
func TestAnArchivedProvidersModelsAreRefusedAndUnlisted(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	up.SetModels("m1")
	addProvider(t, srv, up.URL(), nil, "sk-test-one")
	refresh(t, srv)
	caller := issue(t, srv, "pi", all)
	if got := ids(globalModels(t, caller)); !slices.Contains(got, "acme/m1") {
		t.Fatalf("global list before archiving = %v", got)
	}

	srv.Admin.Patch("/api/providers/acme", map[string]any{"archived": true}).Expect(200)
	if e := caller.Get("/providers/acme/v1/models").Expect(403).Err(); e.Code != "provider_not_allowed" {
		t.Fatalf("archived Provider's list = %+v", e)
	}
	for _, id := range ids(globalModels(t, caller)) {
		if strings.HasPrefix(id, "acme/") {
			t.Fatalf("global list holds %s of an archived Provider", id)
		}
	}
	if e := caller.Post(chatPath, chat("m1")).Expect(403).Err(); e.Code != "provider_not_allowed" {
		t.Fatalf("chat on an archived Provider = %+v", e)
	}
	srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": "m2"}).Expect(201)
}

// MOD-66: a model ID with a slash is added, hidden and reverted through the
// admin API (the ID travels in the body) and its Audit Entries are found by
// <handle>/<model>.
func TestASlashedModelIDIsAddedHiddenAndRevertedLikeAnyOther(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	up.SetModels("m1")
	addProvider(t, srv, up.URL(), nil, "sk-test-one")
	caller := issue(t, srv, "pi", all)

	var res models.ModelResult
	srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": "vendor/m3"}).Expect(201).JSON(&res)
	if res.Outcome != audit.OutcomeCreated || res.Model.Model != "vendor/m3" || !res.Model.Visible {
		t.Fatalf("add = %+v", res)
	}
	caller.Post(chatPath, chat("vendor/m3")).Expect(200)
	if up.Last().Model != "vendor/m3" {
		t.Fatalf("upstream got %q", up.Last().Model)
	}
	srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": "vendor/m3", "hidden": true}).Expect(200).JSON(&res)
	if !res.Model.Hidden || res.Model.Visible {
		t.Fatalf("hide = %+v", res)
	}
	caller.Post(chatPath, chat("vendor/m3")).Expect(404)

	var page audit.EntryPage
	srv.Admin.Get("/api/audit-entries?record=acme/vendor/m3").Expect(200).JSON(&page)
	if len(page.Entries) != 2 || page.Entries[0].Changes[0].Name != "acme/vendor/m3" {
		t.Fatalf("entries = %+v", page)
	}
	srv.Admin.Post("/api/audit-entries/"+page.Entries[0].ID+"/revert", nil).Expect(200)
	if l := list(t, srv, "q=vendor"); names(l) != "vendor/m3" || l.Models[0].Hidden || !l.Models[0].Visible {
		t.Fatalf("after revert = %+v", l.Models)
	}
	if got := callerModels(t, caller, "acme"); got != "vendor/m3" {
		t.Fatalf("caller list = %s", got)
	}
}

// PRV-54: a model list answered with a redirect is a failed list; the
// redirect is never followed, so the key never reaches the other host.
func TestAModelListRedirectIsNeverFollowed(t *testing.T) {
	srv := testkit.Start(t)
	elsewhere := testkit.NewOpenAIChat(t)
	elsewhere.SetModels("stolen")
	up := testkit.NewOpenAIChat(t)
	up.Handle(http.MethodGet, "/v1/models", testkit.Raw(302, "text/plain", "moved").Header("Location", elsewhere.URL()+"/models"))
	addProvider(t, srv, up.URL(), nil, "sk-test-redirected")

	r := refresh(t, srv)
	if r.Outcome != "failed" || len(r.Lists) != 1 || r.Lists[0].Status != 302 {
		t.Fatalf("refresh = %+v", r)
	}
	if elsewhere.Count() != 0 {
		t.Fatalf("the redirect was followed: %d requests reached the other host", elsewhere.Count())
	}
	if l := list(t, srv, ""); len(l.Models) != 0 {
		t.Fatalf("models after a redirected list = %s", names(l))
	}
}
