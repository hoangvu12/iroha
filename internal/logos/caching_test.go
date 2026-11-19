package logos_test

import (
	"bytes"
	"testing"

	"github.com/hoangvu12/iroha/internal/testkit"
)

// UI ticket 32: a record's logo URL stays the same when its logo domain or
// maker changes, so the browser must ask again on each use (no-cache) and an
// unchanged logo costs a 304 (ETag), never a stale image for an hour.
func TestARecordsLogoIsRevalidatedSoADomainChangeShowsAtOnce(t *testing.T) {
	lg := testkit.NewLogos(t)
	lg.SetFavicon("aliyuncs.com", testkit.PNG)
	lg.SetFavicon("alibabacloud.com", testkit.SVG)
	srv := testkit.Start(t, testkit.Options{Logos: lg})
	provider(t, srv, "dashscope", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", nil)

	first := srv.Admin.Get("/api/providers/dashscope/logo").Expect(200)
	if cc := first.Header.Get("Cache-Control"); cc != "private, no-cache" {
		t.Fatalf("Cache-Control %q, want private, no-cache", cc)
	}
	etag := first.Header.Get("ETag")
	if etag == "" {
		t.Fatal("no ETag on a logo")
	}

	// Asked again with the ETag: 304, no body.
	again := srv.Admin.WithHeader("If-None-Match", etag).Get("/api/providers/dashscope/logo").Expect(304)
	if len(again.Body) != 0 {
		t.Fatalf("304 with a body of %d bytes", len(again.Body))
	}

	// The domain changes: the same URL and the old ETag now get the new logo.
	srv.Admin.Patch("/api/providers/dashscope", map[string]any{"logo_domain": "alibabacloud.com"}).OK()
	changed := srv.Admin.WithHeader("If-None-Match", etag).Get("/api/providers/dashscope/logo").Expect(200)
	if !bytes.Equal(changed.Body, testkit.SVG) || changed.Header.Get("ETag") == etag {
		t.Fatalf("after the change: %s, ETag %q", changed.Header.Get("Content-Type"), changed.Header.Get("ETag"))
	}

	// A record with no logo is asked again too, so a logo found later shows.
	srv.Admin.Patch("/api/providers/dashscope", map[string]any{"logo_domain": "none"}).OK()
	if cc := srv.Admin.Get("/api/providers/dashscope/logo").Expect(404).Header.Get("Cache-Control"); cc != "private, no-cache" {
		t.Fatalf("miss Cache-Control %q", cc)
	}

	// A Pool's logo is the same.
	srv.Admin.Post("/api/pools", map[string]any{"name": "fast", "maker": "alibabacloud.com"}).OK()
	pool := srv.Admin.Get("/api/pools/fast/logo").Expect(200)
	if pool.Header.Get("Cache-Control") != "private, no-cache" || pool.Header.Get("ETag") == "" {
		t.Fatalf("Pool logo: Cache-Control %q, ETag %q", pool.Header.Get("Cache-Control"), pool.Header.Get("ETag"))
	}
	srv.Admin.WithHeader("If-None-Match", pool.Header.Get("ETag")).Get("/api/pools/fast/logo").Expect(304)

	// A preview's URL names the domain itself, so it may be kept for an hour.
	preview := srv.Admin.Get("/api/logos?domain=alibabacloud.com").Expect(200)
	if preview.Header.Get("Cache-Control") != "private, max-age=3600" || preview.Header.Get("ETag") == "" {
		t.Fatalf("preview: Cache-Control %q, ETag %q", preview.Header.Get("Cache-Control"), preview.Header.Get("ETag"))
	}
}
