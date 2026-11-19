package webui_test

import (
	"strings"
	"testing"

	"github.com/hoangvu12/iroha/internal/testkit"
)

func TestTheUIAndItsBrandArtAreServedByIroha(t *testing.T) {
	srv := testkit.Start(t)
	page := srv.Anon.WithHeader("Accept", "text/html,application/xhtml+xml")

	root := page.Get("/").Expect(200)
	if !strings.HasPrefix(root.Header.Get("Content-Type"), "text/html") || !strings.Contains(root.Text(), "<title>Iroha</title>") {
		t.Fatalf("GET / = %s\n%.300s", root.Header.Get("Content-Type"), root.Body)
	}
	// The app's own pages load on reload.
	for _, p := range []string{"/providers", "/requests/req_123", "/login", "/settings/admin-tokens"} {
		r := page.Get(p).Expect(200)
		if string(r.Body) != string(root.Body) {
			t.Errorf("%s does not serve the app", p)
		}
	}
	for _, p := range []string{"/brand/iroha-sidebar-banner.jpg", "/brand/iroha-avatar.png"} {
		r := srv.Anon.Get(p).Expect(200)
		if !strings.HasPrefix(r.Header.Get("Content-Type"), "image/") || len(r.Body) < 1000 {
			t.Errorf("%s: %s, %d bytes", p, r.Header.Get("Content-Type"), len(r.Body))
		}
	}

	// Misses that are not page loads, and anything under /api/, stay JSON.
	for _, p := range []string{"/assets/missing.js", "/brand/missing.png"} {
		if e := page.Get(p).Expect(404).Err(); e.Code != "not_found" {
			t.Errorf("%s: %+v", p, e)
		}
	}
	if e := srv.Anon.Get("/nope").Expect(404).Err(); e.Code != "not_found" {
		t.Fatalf("API client miss: %+v", e)
	}
	if e := page.Get("/api/nope").Expect(404).Err(); e.Code != "not_found" {
		t.Fatalf("/api/ miss from a browser: %+v", e)
	}
	if e := srv.Anon.Post("/api/nope", map[string]any{}).Expect(404).Err(); e.Code != "not_found" {
		t.Fatalf("POST miss: %+v", e)
	}
}
