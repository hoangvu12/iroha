package v1import_test

import (
	"net/http"
	"testing"

	"github.com/hoangvu12/iroha/internal/gatewaykeys"
	"github.com/hoangvu12/iroha/internal/providers"
)

// PRV-07, ticket 41: a v1 Provider that required no Upstream Key arrives as
// a keyless key (and only that), and serves a Caller with no credential
// reaching the upstream.
func TestAnImportedKeylessProviderServesWithNoCredential(t *testing.T) {
	srv, f := start(t)
	f.extraKeySQL = []string{`UPDATE providers SET base_url = '` + f.upB.URL() + `' WHERE id = 'p4'`}
	path := newV1(t, f)
	if rep, out := importV1(t, srv, path, true); rep.Failed() != 0 {
		t.Fatalf("report %+v\n%s", rep, out)
	}
	var kl providers.UpstreamKeyList
	srv.Admin.Get("/api/providers/local/keys").OK().JSON(&kl)
	if len(kl.UpstreamKeys) != 1 || kl.UpstreamKeys[0].Secret != "" || kl.UpstreamKeys[0].State.State != "active" {
		t.Fatalf("local keys %+v", kl.UpstreamKeys)
	}
	var gl gatewaykeys.GatewayKeyList
	srv.Admin.Get("/api/gateway-keys").OK().JSON(&gl)
	caller := srv.Client(gl.GatewayKeys[0].Secret)
	for _, k := range gl.GatewayKeys {
		if k.Name == "friend-one" {
			caller = srv.Client(k.Secret)
		}
	}
	caller.Post("/providers/local/v1/chat/completions", map[string]any{"model": "m", "messages": []any{map[string]any{"role": "user", "content": "hi"}}}).OK()
	got := f.upB.Last()
	if got.Method != http.MethodPost || got.Header.Get("Authorization") != "" || got.Header.Get("X-Api-Key") != "" || len(got.Query) != 0 {
		t.Fatalf("upstream got %s %s %v %v", got.Method, got.Path, got.Header, got.Query)
	}
}
