package providers_test

import (
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/providers"
	"github.com/hoangvu12/iroha/internal/testkit"
)

func TestTheOverviewCountsKeysModelsAndTrafficPerProviderAndPool(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme"}).Expect(201)
	srv.Admin.Post("/api/providers", map[string]any{"handle": "idle"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"url": up.URL(), "shape": "openai-chat"}).Expect(201)
	srv.NoConversationIDs("acme") // the 400 below fails its Request
	for _, s := range []string{"sk-test-1", "sk-test-2", "sk-test-3"} {
		srv.Admin.Post("/api/providers/acme/keys", map[string]any{"secret": s}).Expect(201)
	}
	srv.Admin.Post("/api/providers/acme/keys/key-3/disable", nil).OK()
	srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": "m1"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": "m2"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": "secret", "hidden": true}).Expect(201)
	srv.Admin.Post("/api/pools", map[string]any{"name": "p", "members": []any{map[string]any{"provider": "acme", "model": "m1"}}}).Expect(201)
	srv.Admin.Post("/api/pools", map[string]any{"name": "quiet"}).Expect(201)
	var gk struct {
		GatewayKey struct{ Secret string } `json:"gateway_key"`
	}
	srv.Admin.Post("/api/gateway-keys", map[string]any{"name": "pi", "scope": map[string]any{"all": true}}).Expect(201).JSON(&gk)
	caller := srv.Client(gk.GatewayKey.Secret)

	// An old Request falls outside the window.
	caller.Post("/v1/chat/completions", map[string]any{"model": "acme/m1", "messages": []any{map[string]any{"role": "user", "content": "hi"}}}).Expect(200)
	srv.Clock.Advance(25 * time.Hour)
	up.Enqueue(up.Error(400, "bad"))
	caller.Post("/v1/chat/completions", map[string]any{"model": "p", "messages": []any{map[string]any{"role": "user", "content": "hi"}}}).Expect(400)
	caller.Post("/v1/chat/completions", map[string]any{"model": "p", "messages": []any{map[string]any{"role": "user", "content": "hi"}}}).Expect(200)
	caller.Post("/v1/chat/completions", map[string]any{"model": "acme/m2", "messages": []any{map[string]any{"role": "user", "content": "hi"}}}).Expect(200)

	var ov providers.Overview
	srv.Admin.Get("/api/overview").Expect(200).JSON(&ov)
	if len(ov.Providers) != 2 || len(ov.Pools) != 2 {
		t.Fatalf("overview = %+v", ov)
	}
	a, idle := ov.Providers[0], ov.Providers[1]
	if a.Provider != "acme" || a.Keys.Total != 3 || a.Keys.Active != 2 || a.Keys.Disabled != 1 || a.Models != 2 ||
		a.Requests != 3 || a.Succeeded != 2 || a.Failed != 1 || a.LastRequestAt == nil {
		t.Fatalf("acme = %+v", a)
	}
	if idle.Provider != "idle" || idle.Requests != 0 || idle.Keys.Total != 0 || idle.LastRequestAt != nil {
		t.Fatalf("idle = %+v", idle)
	}
	p, quiet := ov.Pools[0], ov.Pools[1]
	if p.Pool != "p" || p.Requests != 2 || p.Succeeded != 1 || p.Failed != 1 || len(p.ServedBy) != 1 || p.ServedBy[0].Provider != "acme" || p.ServedBy[0].Succeeded != 1 {
		t.Fatalf("pool p = %+v", p)
	}
	if quiet.Pool != "quiet" || quiet.Requests != 0 || quiet.ServedBy == nil {
		t.Fatalf("pool quiet = %+v", quiet)
	}

	// A longer window takes the old Request in.
	srv.Admin.Get("/api/overview?since=48h").Expect(200).JSON(&ov)
	if ov.Providers[0].Requests != 4 {
		t.Fatalf("48h = %+v", ov.Providers[0])
	}
	srv.Admin.Get("/api/overview?since=yesterday").Expect(400)
}
