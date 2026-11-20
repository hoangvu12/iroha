package server_test

import (
	"testing"

	"github.com/hoangvu12/iroha/internal/testkit"
)

// UI ticket 32: admin API answers hold configuration and secrets (Upstream
// Keys, Gateway Keys) and the UI keeps its own cache (TanStack Query), so
// no browser or proxy stores them: every /api/ answer, errors included, is
// no-store unless the route says otherwise (logos do).
func TestAdminAPIAnswersAreNeverStored(t *testing.T) {
	srv := testkit.Start(t)
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme"}).OK()

	for _, c := range []struct {
		name string
		r    *testkit.Response
	}{
		{"list", srv.Admin.Get("/api/providers").Expect(200)},
		{"one", srv.Admin.Get("/api/providers/acme").Expect(200)},
		{"change", srv.Admin.Patch("/api/providers/acme", map[string]any{"name": "Acme"}).Expect(200)},
		{"not found", srv.Admin.Get("/api/providers/nope").Expect(404)},
		{"signed out", srv.Anon.Get("/api/providers").Expect(401)},
		{"no route", srv.Admin.Get("/api/nope").Expect(404)},
		{"session", srv.Anon.Get("/api/session").Expect(200)},
	} {
		if cc := c.r.Header.Get("Cache-Control"); cc != "no-store" {
			t.Errorf("%s: Cache-Control %q, want no-store", c.name, cc)
		}
	}
}
