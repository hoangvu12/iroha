package models_test

import (
	"fmt"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/models"
	"github.com/hoangvu12/iroha/internal/testkit"
)

func addListed(t *testing.T, srv *testkit.Server, handle string, up *testkit.Upstream) {
	t.Helper()
	srv.Admin.Post("/api/providers", map[string]any{"handle": handle}).Expect(201)
	srv.Admin.Post("/api/providers/"+handle+"/endpoints", map[string]any{"url": up.URL(), "shape": "openai-chat"}).Expect(201)
	srv.Admin.Post("/api/providers/"+handle+"/keys", map[string]any{"secret": "sk-test-" + handle}).Expect(201)
	srv.Admin.Post("/api/providers/"+handle+"/models/refresh", nil).Expect(200)
}

func globalModels(t *testing.T, c *testkit.Client) []models.CallerModel {
	t.Helper()
	var out models.CallerModelList
	c.Get("/v1/models").Expect(200).JSON(&out)
	if out.Object != "list" {
		t.Fatalf("object = %q", out.Object)
	}
	return out.Data
}

func ids(list []models.CallerModel) []string {
	out := []string{}
	for _, m := range list {
		out = append(out, m.ID)
	}
	return out
}

func TestGlobalModelListShowsExactlyWhatTheKeyMayUseQualified(t *testing.T) {
	srv := testkit.Start(t)
	acme := testkit.NewOpenAIChat(t)
	acme.Handle("GET", "/v1/models", testkit.JSON(200, map[string]any{"data": []any{
		map[string]any{"id": "m1", "context_length": 1000000}, map[string]any{"id": "m2"}, map[string]any{"id": "vendor/m3"}}}))
	addListed(t, srv, "acme", acme)
	other := testkit.NewOpenAIChat(t)
	other.SetModels("x1")
	addListed(t, srv, "other", other)
	off := testkit.NewOpenAIChat(t)
	off.SetModels("y1")
	addListed(t, srv, "off", off)
	srv.Admin.Patch("/api/providers/off", map[string]any{"enabled": false}).OK()
	srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": "m2", "hidden": true}).Expect(201)
	srv.Admin.Post("/api/providers/other/models", map[string]any{"model": "x0"}).Expect(201)

	wide := issue(t, srv, "wide", all)
	list := globalModels(t, wide)
	if got := fmt.Sprint(ids(list)); got != "[acme/m1 acme/vendor/m3 other/x0 other/x1]" {
		t.Fatalf("all = %s", got)
	}
	m1 := list[0]
	if m1.Object != "model" || m1.OwnedBy != "acme" || m1.ContextLength == nil || *m1.ContextLength != 1000000 || m1.Chat != "ok" || m1.Created == 0 {
		t.Fatalf("acme/m1 = %+v", m1)
	}
	if list[3].OwnedBy != "other" || list[3].Chat != "ok" {
		t.Fatalf("other/x1 = %+v", list[3])
	}

	narrow := srv.Client(issueSecret(t, srv, "narrow", map[string]any{"providers": []any{
		map[string]any{"provider": "other"},
		map[string]any{"provider": "acme", "models": []string{"zz-unlisted", "m2", "vendor/m3"}},
		map[string]any{"provider": "off"}}}))
	if got := fmt.Sprint(ids(globalModels(t, narrow))); got != "[acme/vendor/m3 acme/zz-unlisted other/x0 other/x1]" {
		t.Fatalf("narrow = %s", got)
	}
	none := issue(t, srv, "none", map[string]any{"providers": []any{}})
	if got := globalModels(t, none); len(got) != 0 {
		t.Fatalf("empty scope = %v", ids(got))
	}

	srv.Anon.Get("/v1/models").Expect(401)
	srv.Client("sk-iroha_wrong").Get("/v1/models").Expect(401)
	if got := globalModels(t, srv.Anon.WithHeader("x-api-key", issueSecret(t, srv, "claude", all))); len(got) != 4 {
		t.Fatalf("x-api-key list = %v", ids(got))
	}
}

func issueSecret(t *testing.T, srv *testkit.Server, name string, scope any) string {
	t.Helper()
	var out struct {
		GatewayKey struct{ Secret string } `json:"gateway_key"`
	}
	srv.Admin.Post("/api/gateway-keys", map[string]any{"name": name, "scope": scope}).Expect(201).JSON(&out)
	return out.GatewayKey.Secret
}

func TestGlobalModelListAnswersQuicklyWith2000Models(t *testing.T) {
	srv := testkit.Start(t)
	for p := 0; p < 2; p++ {
		up := testkit.NewOpenAIChat(t)
		var data []any
		for i := 0; i < 1000; i++ {
			data = append(data, map[string]any{"id": fmt.Sprintf("model-%04d", i), "context_length": 128000 + i, "max_output_tokens": 8192})
		}
		up.Handle("GET", "/v1/models", testkit.JSON(200, map[string]any{"data": data}))
		addListed(t, srv, fmt.Sprintf("p%d", p), up)
	}
	srv.Admin.Post("/api/providers/p0/models", map[string]any{"model": "model-0007", "metadata": map[string]any{"context_length": 1000000}}).Expect(201)
	caller := issue(t, srv, "pi", all)

	globalModels(t, caller)
	start := time.Now()
	list := globalModels(t, caller)
	took := time.Since(start)
	if len(list) != 2000 || list[0].ID != "p0/model-0000" || list[1999].ID != "p1/model-0999" {
		t.Fatalf("list = %d entries, %s .. %s", len(list), list[0].ID, list[len(list)-1].ID)
	}
	if c := list[7].ContextLength; c == nil || *c != 1000000 {
		t.Fatalf("override lost: %+v", list[7])
	}
	if c := list[1001].ContextLength; c == nil || *c != 128001 {
		t.Fatalf("reported metadata lost: %+v", list[1001])
	}
	if took > 1500*time.Millisecond {
		t.Fatalf("GET /v1/models with 2000 models took %v", took)
	}
	t.Logf("GET /v1/models with 2000 models: %v", took)
}
