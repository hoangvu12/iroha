package webui_test

import (
	"regexp"
	"strings"
	"testing"

	"github.com/hoangvu12/iroha/internal/testkit"
	"github.com/hoangvu12/iroha/internal/webui"
)

func TestTheUIAndItsBrandArtAreServedByIroha(t *testing.T) {
	srv := testkit.Start(t)
	page := srv.Anon.WithHeader("Accept", "text/html,application/xhtml+xml")

	root := page.Get("/").Expect(200)
	if !strings.HasPrefix(root.Header.Get("Content-Type"), "text/html") || !strings.Contains(root.Text(), "<title>Iroha</title>") {
		t.Fatalf("GET / = %s\n%.300s", root.Header.Get("Content-Type"), root.Body)
	}
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

func TestUICachingAndPathsThatClimbOutOfTheBundle(t *testing.T) {
	srv := testkit.Start(t)
	page := srv.Anon.WithHeader("Accept", "text/html,application/xhtml+xml")
	root := page.Get("/").Expect(200)
	for _, p := range []string{"/", "/index.html", "/providers"} {
		if r := page.Get(p).Expect(200); r.Header.Get("Cache-Control") != "no-cache" || r.Header.Get("X-Frame-Options") != "DENY" {
			t.Errorf("%s: Cache-Control %q, X-Frame-Options %q", p, r.Header.Get("Cache-Control"), r.Header.Get("X-Frame-Options"))
		}
	}
	if r := srv.Anon.Get("/brand/iroha-avatar.png").Expect(200); r.Header.Get("Cache-Control") != "public, max-age=86400" {
		t.Errorf("brand art Cache-Control %q", r.Header.Get("Cache-Control"))
	}
	if webui.Built() {
		asset := regexp.MustCompile(`/assets/[^"']+`).FindString(root.Text())
		if asset == "" {
			t.Fatalf("the built index.html names no asset:\n%s", root.Body)
		}
		if r := srv.Anon.Get(asset).Expect(200); r.Header.Get("Cache-Control") != "public, max-age=31536000, immutable" {
			t.Errorf("%s: Cache-Control %q", asset, r.Header.Get("Cache-Control"))
		}
	}

	files := []string{"/", "/providers", "/brand/iroha-avatar.png"}
	if webui.Built() {
		files = append(files, regexp.MustCompile(`/assets/[^"']+`).FindString(root.Text()))
	}
	for _, p := range files {
		r := page.Get(p).Expect(200)
		etag := r.Header.Get("ETag")
		if etag == "" {
			t.Errorf("%s: no ETag", p)
			continue
		}
		again := page.WithHeader("If-None-Match", etag).Get(p).Expect(304)
		if len(again.Body) != 0 || again.Header.Get("Cache-Control") != r.Header.Get("Cache-Control") {
			t.Errorf("%s: 304 with %d bytes, Cache-Control %q", p, len(again.Body), again.Header.Get("Cache-Control"))
		}
	}
	if page.Get("/").Header.Get("ETag") != page.Get("/providers").Header.Get("ETag") {
		t.Error("the app page has two ETags")
	}
	for _, p := range []string{"/assets/index-gone.js", "/brand/gone.png"} {
		if cc := page.Get(p).Expect(404).Header.Get("Cache-Control"); cc != "no-store" {
			t.Errorf("%s: Cache-Control %q, want no-store", p, cc)
		}
	}

	outside := []string{"SQLite format", "package webui", "module github.com"}
	for _, p := range []string{
		"/../iroha.db", "/%2e%2e/", "/%2e%2e/iroha.db", "/brand/../../webui.go", "/brand/%2e%2e/%2e%2e/webui.go",
		"/assets/..%2f..%2fwebui.go", "/brand/..%5c..%5cwebui.go", "/..%5c..%5cgo.mod", "/../../../go.mod", "//etc/passwd",
		"/" + srv.DataDir + "/iroha.db",
	} {
		for _, c := range []*testkit.Client{srv.Anon, page} {
			r := c.Get(p)
			switch {
			case r.Status == 200 && r.Text() == root.Text():
			case r.Status == 404 && strings.Contains(r.Text(), `"not_found"`):
			default:
				t.Errorf("%s: %d, want the app page or the JSON 404:\n%.200s", p, r.Status, r.Body)
			}
			for _, s := range outside {
				if strings.Contains(r.Text(), s) {
					t.Errorf("%s served a file from outside the bundle (%q)", p, s)
				}
			}
		}
	}
}
