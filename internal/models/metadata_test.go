package models_test

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/modelmeta"
	"github.com/hoangvu12/iroha/internal/models"
	"github.com/hoangvu12/iroha/internal/testkit"
)

func fakeModelsDev(t *testing.T) *testkit.ModelsDev {
	md := testkit.NewModelsDev(t)
	md.SetProvider("zai-coding-plan", map[string]any{
		"glm-4.6": map[string]any{"id": "glm-4.6", "limit": map[string]any{"context": 204800, "output": 131072},
			"modalities": map[string]any{"input": []string{"text"}, "output": []string{"text"}}, "reasoning": true,
			"reasoning_options": []any{map[string]any{"type": "effort", "values": []string{"low", "high"}}}},
	})
	md.SetModel("openai/gpt-4o", map[string]any{"id": "gpt-4o", "limit": map[string]any{"context": 128000, "output": 16384},
		"modalities": map[string]any{"input": []string{"text", "image"}, "output": []string{"text"}}})
	md.SetModel("openai/text-embedding-3-small", map[string]any{"id": "text-embedding-3-small", "limit": map[string]any{"context": 8191},
		"modalities": map[string]any{"input": []string{"text"}, "output": []string{"embedding"}}})
	md.SetModel("first/shared", map[string]any{"id": "shared", "limit": map[string]any{"context": 1000}})
	md.SetModel("second/shared", map[string]any{"id": "shared", "limit": map[string]any{"context": 2000}})
	return md
}

func serveList(up *testkit.Upstream, items ...map[string]any) {
	up.Handle(http.MethodGet, "/v1/models", testkit.JSON(200, map[string]any{"object": "list", "data": items}))
}

func callerList(t *testing.T, c *testkit.Client, handle string) map[string]models.CallerModel {
	t.Helper()
	var out models.CallerModelList
	c.Get("/providers/" + handle + "/v1/models").Expect(200).JSON(&out)
	m := map[string]models.CallerModel{}
	for _, e := range out.Data {
		m[e.ID] = e
	}
	return m
}

func facts(m models.CallerModel) string {
	b, _ := json.Marshal(m.Facts)
	return string(b)
}

func TestCallerListCarriesMetadataOwnerThenProviderThenModelsDev(t *testing.T) {
	md := fakeModelsDev(t)
	srv := testkit.Start(t, testkit.Options{ModelsDev: md.URL})
	up := testkit.NewOpenAIChat(t)
	serveList(up,
		map[string]any{"id": "glm-4.6", "object": "model", "context_length": "1000000"},
		map[string]any{"id": "gpt-4o", "object": "model"},
		map[string]any{"id": "text-embedding-3-small", "object": "model"},
		map[string]any{"id": "shared", "object": "model"},
		map[string]any{"id": "mystery-1", "object": "model"},
	)
	addProvider(t, srv, up.URL(), map[string]any{"models_dev_brand": "zai-coding-plan"}, "sk-test-one")

	if r := refresh(t, srv); r.Outcome != "ok" || r.ModelsDev != "ok" {
		t.Fatalf("refresh = %+v", r)
	}
	caller := issue(t, srv, "pi", all)
	got := callerList(t, caller, "acme")
	want := map[string]string{
		"glm-4.6":                `{"context_length":1000000,"max_output_tokens":131072,"architecture":{"input_modalities":["text"],"output_modalities":["text"]},"reasoning":true,"reasoning_levels":["low","high"],"chat":"ok"}`,
		"gpt-4o":                 `{"context_length":128000,"max_output_tokens":16384,"architecture":{"input_modalities":["text","image"],"output_modalities":["text"]},"chat":"ok"}`,
		"text-embedding-3-small": `{"context_length":8191,"architecture":{"input_modalities":["text"],"output_modalities":["embedding"]},"chat":"unsupported"}`,
		"shared":                 `{"chat":"ok"}`,
		"mystery-1":              `{"chat":"ok"}`,
	}
	if len(got) != len(want) {
		t.Fatalf("caller list = %+v", got)
	}
	for id, w := range want {
		if f := facts(got[id]); f != w {
			t.Errorf("%s\n got %s\nwant %s", id, f, w)
		}
	}

	var res models.ModelResult
	srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": "glm-4.6", "metadata": map[string]any{"context_length": 200000, "chat": "ok"}}).
		Expect(201).JSON(&res)
	if res.Model.Added || !res.Model.Discovered || *res.Model.Metadata.ContextLength != 200000 || *res.Model.Reported.ContextLength != 1000000 ||
		*res.Model.ModelsDev.ContextLength != 204800 || *res.Model.Overrides.ContextLength != 200000 {
		t.Fatalf("override result = %+v", res.Model)
	}
	if f := facts(callerList(t, caller, "acme")["glm-4.6"]); f != `{"context_length":200000,"max_output_tokens":131072,"architecture":{"input_modalities":["text"],"output_modalities":["text"]},"reasoning":true,"reasoning_levels":["low","high"],"chat":"ok"}` {
		t.Fatalf("glm-4.6 after override = %s", f)
	}
	srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": "text-embedding-3-small", "metadata": map[string]any{"chat": "ok"}}).Expect(201)
	if c := callerList(t, caller, "acme")["text-embedding-3-small"].Chat; c != "ok" {
		t.Fatalf("chat after override = %q", c)
	}

	srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": "text-embedding-3-small", "metadata": map[string]any{}}).OK()
	caller.Post(chatPath, chat("text-embedding-3-small")).OK()
	if up.Last().Model != "text-embedding-3-small" {
		t.Fatalf("upstream got %q", up.Last().Model)
	}

	l := list(t, srv, "q=gpt-4o")
	if len(l.Models) != 1 || *l.Models[0].ModelsDev.ContextLength != 128000 || !l.Models[0].Reported.IsZero() || !l.Models[0].Overrides.IsZero() ||
		l.Models[0].Metadata.Chat != "ok" {
		t.Fatalf("admin entry = %+v", l.Models)
	}
}

func TestModelsDevOutageNeverFailsDiscovery(t *testing.T) {
	md := fakeModelsDev(t)
	md.Fail(http.StatusServiceUnavailable)
	srv := testkit.Start(t, testkit.Options{ModelsDev: md.URL})
	up := testkit.NewOpenAIChat(t)
	up.SetModels("gpt-4o")
	addProvider(t, srv, up.URL(), nil, "sk-test-one")
	caller := issue(t, srv, "pi", all)

	r := refresh(t, srv)
	if r.Outcome != "ok" || r.Discovered != 1 || r.ModelsDev != "unavailable" {
		t.Fatalf("refresh during an outage = %+v", r)
	}
	if f := facts(callerList(t, caller, "acme")["gpt-4o"]); f != `{"chat":"ok"}` {
		t.Fatalf("gpt-4o during an outage = %s", f)
	}
	if ev := srv.Logs("kind=models_dev&level=warn"); len(ev) == 0 || ev[0].Attrs["outcome"] != "failed" {
		t.Fatalf("models_dev events = %+v", ev)
	}

	md.Fail(0)
	srv.Clock.Advance(modelmeta.RetryAfter)
	if r := refresh(t, srv); r.ModelsDev != "ok" {
		t.Fatalf("refresh after the outage = %+v", r)
	}
	if f := facts(callerList(t, caller, "acme")["gpt-4o"]); f == `{"chat":"ok"}` {
		t.Fatal("gpt-4o has no facts after models.dev came back")
	}

	md.Fail(http.StatusBadGateway)
	srv.Clock.Advance(modelmeta.CacheTTL)
	if r := refresh(t, srv); r.Outcome != "ok" || r.ModelsDev != "stale" {
		t.Fatalf("refresh during a second outage = %+v", r)
	}
	if c := callerList(t, caller, "acme")["gpt-4o"].ContextLength; c == nil || *c != 128000 {
		t.Fatalf("context during a second outage = %v", c)
	}
}

func TestOwnerMetadataOverridesAreAuditedRevertibleAndOutliveDiscovery(t *testing.T) {
	md := fakeModelsDev(t)
	srv := testkit.Start(t, testkit.Options{ModelsDev: md.URL})
	up := testkit.NewOpenAIChat(t)
	up.SetModels("gpt-4o")
	addProvider(t, srv, up.URL(), nil, "sk-test-one")
	refresh(t, srv)

	for _, bad := range []map[string]any{
		{"context_length": -1},
		{"chat": "maybe"},
		{"architecture": map[string]any{"input_modalities": []string{"two words"}}},
		{"reasoning": false, "reasoning_levels": []string{"low"}},
		{"context_window": 5},
	} {
		srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": "gpt-4o", "metadata": bad}).Expect(400)
	}

	srv.Admin.Post("/api/providers/acme/models?dry_run=true", map[string]any{"model": "gpt-4o", "metadata": map[string]any{"max_output_tokens": 1}}).OK()
	if l := list(t, srv, ""); !l.Models[0].Overrides.IsZero() {
		t.Fatalf("dry run wrote overrides: %+v", l.Models[0])
	}

	var res models.ModelResult
	srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": "gpt-4o",
		"metadata": map[string]any{"max_output_tokens": 32000, "architecture": map[string]any{"input_modalities": []string{"Text", "image", "text"}}}}).
		Expect(201).JSON(&res)
	if res.Outcome != audit.OutcomeCreated || res.AuditEntry == "" || res.Model.Added || res.Model.Hidden ||
		facts(models.CallerModel{Facts: res.Model.Overrides}) != `{"max_output_tokens":32000,"architecture":{"input_modalities":["text","image"]}}` {
		t.Fatalf("override = %+v", res)
	}
	srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": "gpt-4o",
		"metadata": map[string]any{"max_output_tokens": 32000, "architecture": map[string]any{"input_modalities": []string{"text", "image"}}}}).
		Expect(200).JSON(&res)
	if res.Outcome != audit.OutcomeUnchanged {
		t.Fatalf("repeat = %+v", res.Result)
	}

	up.SetModels("other")
	refresh(t, srv)
	l := list(t, srv, "q=gpt-4o")
	if len(l.Models) != 1 || l.Models[0].Visible || *l.Models[0].Overrides.MaxOutputTokens != 32000 {
		t.Fatalf("entry after discovery dropped it = %+v", l.Models)
	}
	up.SetModels("gpt-4o")
	refresh(t, srv)
	caller := issue(t, srv, "pi", all)
	if m := callerList(t, caller, "acme")["gpt-4o"]; *m.MaxOutputTokens != 32000 || *m.ContextLength != 128000 {
		t.Fatalf("listed again = %s", facts(m))
	}

	var entries audit.EntryPage
	srv.Admin.Get("/api/audit-entries?record=acme/gpt-4o").OK().JSON(&entries)
	if len(entries.Entries) != 1 {
		t.Fatalf("audit entries = %+v", entries.Entries)
	}
	srv.Admin.Post("/api/audit-entries/"+entries.Entries[0].ID+"/revert", nil).OK()
	if m := callerList(t, caller, "acme")["gpt-4o"]; *m.MaxOutputTokens != 16384 {
		t.Fatalf("after revert = %s", facts(m))
	}

	srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": "ghost", "metadata": map[string]any{"context_length": 5}}).Expect(201)
	if l := list(t, srv, "q=ghost"); len(l.Models) != 1 || l.Models[0].Visible {
		t.Fatalf("override-only entry = %+v", l.Models)
	}
	if got := callerModels(t, caller, "acme"); got != "gpt-4o" {
		t.Fatalf("caller list with an override-only entry = %s", got)
	}
	srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": "ghost", "metadata": map[string]any{}}).OK()
	if l := list(t, srv, "q=ghost"); len(l.Models) != 0 {
		t.Fatalf("cleared entry = %+v", l.Models)
	}
}

func TestOwnerAdditionsAreLookedUpAtOnceAndTheBrandDecides(t *testing.T) {
	md := fakeModelsDev(t)
	srv := testkit.Start(t, testkit.Options{ModelsDev: md.URL})
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme", "discovery": "none"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"url": testkit.NewOpenAIChat(t).URL(), "shape": "openai-chat"}).Expect(201)
	caller := issue(t, srv, "pi", all)

	var res models.ModelResult
	srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": "glm-4.6"}).Expect(201).JSON(&res)
	if !res.Model.Added || !res.Model.ModelsDev.IsZero() {
		t.Fatalf("added without a brand = %+v", res.Model)
	}

	srv.Admin.Patch("/api/providers/acme", map[string]any{"models_dev_brand": "zai-coding-plan"}).OK()
	var p struct {
		ModelsDevBrand string `json:"models_dev_brand"`
	}
	srv.Admin.Get("/api/providers/acme").OK().JSON(&p)
	if p.ModelsDevBrand != "zai-coding-plan" {
		t.Fatalf("brand = %q", p.ModelsDevBrand)
	}
	if r := refresh(t, srv); r.Outcome != "skipped" || r.ModelsDev != "ok" {
		t.Fatalf("refresh = %+v", r)
	}
	if c := callerList(t, caller, "acme")["glm-4.6"].ContextLength; c == nil || *c != 204800 {
		t.Fatalf("glm-4.6 under the brand = %v", c)
	}

	srv.Admin.Patch("/api/providers/acme", map[string]any{"models_dev_brand": "anthropic"}).OK()
	if f := facts(callerList(t, caller, "acme")["glm-4.6"]); f != `{"chat":"ok"}` {
		t.Fatalf("glm-4.6 under another brand = %s", f)
	}

	srv.Admin.Post("/api/providers/acme/models/bulk", map[string]any{"items": []any{map[string]any{"model": "gpt-4o"}}}).OK()
	if c := callerList(t, caller, "acme")["gpt-4o"].ContextLength; c == nil || *c != 128000 {
		t.Fatalf("gpt-4o right after adding = %v", c)
	}

	srv.Admin.Patch("/api/providers/acme", map[string]any{"models_dev_brand": "Not A Brand"}).Expect(400)
	srv.Admin.Patch("/api/providers/acme", map[string]any{"models_dev_brand": ""}).OK()
}

func TestWithoutModelsDevNothingIsRead(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	up.SetModels("gpt-4o")
	addProvider(t, srv, up.URL(), nil, "sk-test-one")
	if r := refresh(t, srv); r.ModelsDev != "off" {
		t.Fatalf("refresh = %+v", r)
	}
	srv.Clock.Advance(time.Hour)
	if f := facts(callerList(t, issue(t, srv, "pi", all), "acme")["gpt-4o"]); f != `{"chat":"ok"}` {
		t.Fatalf("gpt-4o = %s", f)
	}
}
