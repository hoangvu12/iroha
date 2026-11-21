package logos_test

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/logos"
	"github.com/hoangvu12/iroha/internal/testkit"
)

func provider(t *testing.T, srv *testkit.Server, handle, url string, extra map[string]any) {
	t.Helper()
	body := map[string]any{"handle": handle}
	for k, v := range extra {
		body[k] = v
	}
	srv.Admin.Post("/api/providers", body).OK()
	if url != "" {
		srv.Admin.Post("/api/providers/"+handle+"/endpoints", map[string]any{"url": url, "shape": "openai-chat"}).OK()
	}
}

func TestAProviderLogoIsFetchedThroughIrohaFromItsLogoDomain(t *testing.T) {
	lg := testkit.NewLogos(t)
	lg.SetFavicon("aliyuncs.com", testkit.PNG)
	lg.SetFavicon("alibabacloud.com", testkit.SVG)
	srv := testkit.Start(t, testkit.Options{Logos: lg})

	provider(t, srv, "dashscope", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", nil)
	var p struct {
		LogoDomain  string `json:"logo_domain"`
		LogoGuessed bool   `json:"logo_domain_guessed"`
	}
	srv.Admin.Get("/api/providers/dashscope").Expect(200).JSON(&p)
	if p.LogoDomain != "aliyuncs.com" || !p.LogoGuessed {
		t.Fatalf("provider = %+v", p)
	}
	resp := srv.Admin.Get("/api/providers/dashscope/logo").Expect(200)
	if !bytes.Equal(resp.Body, testkit.PNG) || resp.Header.Get("Content-Type") != "image/png" || !strings.Contains(resp.Header.Get("Cache-Control"), "private") {
		t.Fatalf("logo: %s %q", resp.Header.Get("Content-Type"), resp.Body)
	}

	var upd struct {
		AuditEntry string `json:"audit_entry"`
		Provider   struct {
			LogoDomain  string `json:"logo_domain"`
			LogoGuessed bool   `json:"logo_domain_guessed"`
		}
	}
	srv.Admin.Patch("/api/providers/dashscope", map[string]any{"logo_domain": "https://AlibabaCloud.com/path"}).Expect(200).JSON(&upd)
	if upd.Provider.LogoDomain != "alibabacloud.com" || upd.Provider.LogoGuessed || upd.AuditEntry == "" {
		t.Fatalf("update = %+v", upd)
	}
	resp = srv.Admin.Get("/api/providers/dashscope/logo").Expect(200)
	if !bytes.Equal(resp.Body, testkit.SVG) || resp.Header.Get("Content-Type") != "image/svg+xml" || !strings.Contains(resp.Header.Get("Content-Security-Policy"), "sandbox") {
		t.Fatalf("logo: %s %q", resp.Header.Get("Content-Type"), resp.Body)
	}
	srv.Admin.Post("/api/audit-entries/"+upd.AuditEntry+"/revert", nil).OK()
	srv.Admin.Get("/api/providers/dashscope").Expect(200).JSON(&p)
	if p.LogoDomain != "aliyuncs.com" || !p.LogoGuessed {
		t.Fatalf("after revert = %+v", p)
	}

	for _, bad := range []string{"localhost", "10.0.0.1", "exa mple.com", "user@example.com"} {
		srv.Admin.Patch("/api/providers/dashscope", map[string]any{"logo_domain": bad}).Expect(400)
	}
	srv.Admin.Patch("/api/providers/dashscope", map[string]any{"logo_domain": "none"}).Expect(200)
	if e := srv.Admin.Get("/api/providers/dashscope/logo").Expect(404).Err(); e.Code != "logo_unavailable" || e.Hint == "" {
		t.Fatalf("no logo = %+v", e)
	}
	if e := srv.Admin.Get("/api/providers/nope/logo").Expect(404).Err(); e.Code != "not_found" {
		t.Fatalf("unknown = %+v", e)
	}
	srv.Anon.Get("/api/providers/dashscope/logo").Expect(401)
}

func TestLogoLookupsAreCachedAndFailuresAreAMissNotABrokenImage(t *testing.T) {
	lg := testkit.NewLogos(t)
	srv := testkit.Start(t, testkit.Options{Logos: lg})
	provider(t, srv, "zai", "https://api.z.ai/api/paas/v4", nil)

	srv.Admin.Get("/api/providers/zai/logo").Expect(404)
	srv.Admin.Get("/api/providers/zai/logo").Expect(404)
	if n := len(lg.Hits()); n != 1 {
		t.Fatalf("source asked %d times: %v", n, lg.Hits())
	}
	lg.SetFavicon("z.ai", testkit.PNG)
	srv.Clock.Advance(logos.MissTTL + time.Second)
	srv.Admin.Get("/api/providers/zai/logo").Expect(200)
	srv.Admin.Get("/api/providers/zai/logo").Expect(200)
	if n := len(lg.Hits()); n != 2 {
		t.Fatalf("source asked %d times: %v", n, lg.Hits())
	}

	lg.Fail(500)
	srv.Restart()
	srv.Admin.Get("/api/providers/zai/logo").Expect(200)
	srv.Clock.Advance(logos.HitTTL + time.Second)
	if resp := srv.Admin.Get("/api/providers/zai/logo").Expect(200); !bytes.Equal(resp.Body, testkit.PNG) {
		t.Fatalf("stale copy not served: %q", resp.Body)
	}

	lg.Fail(0)
	lg.SetFavicon("example.com", []byte("<html>blocked</html>"))
	srv.Admin.Get("/api/logos?domain=example.com").Expect(404)
	srv.Admin.Get("/api/logos?domain=127.0.0.1").Expect(400)
}

func TestAPoolLogoIsItsMakersMarkElseTheMakersSiteElseNone(t *testing.T) {
	lg := testkit.NewLogos(t)
	lg.SetMaker("zhipuai", testkit.SVG)
	lg.SetFavicon("moonshot.ai", testkit.PNG)
	srv := testkit.Start(t, testkit.Options{Logos: lg})
	provider(t, srv, "zai", "https://api.z.ai/api/paas/v4", nil)
	for _, name := range []string{"glm-4.6", "kimi-k2", "house-mix"} {
		srv.Admin.Post("/api/pools", map[string]any{"name": name, "members": []any{map[string]any{"provider": "zai", "model": name}}}).Expect(201)
	}

	if resp := srv.Admin.Get("/api/pools/glm-4.6/logo").Expect(200); !bytes.Equal(resp.Body, testkit.SVG) {
		t.Fatalf("glm logo = %q", resp.Body)
	}
	if resp := srv.Admin.Get("/api/pools/kimi-k2/logo").Expect(200); !bytes.Equal(resp.Body, testkit.PNG) {
		t.Fatalf("kimi logo = %q", resp.Body)
	}
	srv.Admin.Get("/api/pools/house-mix/logo").Expect(404)
	srv.Admin.Patch("/api/pools/house-mix", map[string]any{"maker": "zhipuai"}).OK()
	srv.Admin.Get("/api/pools/house-mix/logo").Expect(200)
	srv.Admin.Get("/api/logos?maker=zhipuai").Expect(200)
	srv.Admin.Get("/api/logos?maker=unknown-maker").Expect(404)
	srv.Admin.Get("/api/pools/nope/logo").Expect(404)
}

func TestAPoolLogoIsAMakerOrAWebsite(t *testing.T) {
	lg := testkit.NewLogos(t)
	lg.SetMaker("openai", testkit.SVG)
	lg.SetFavicon("chatgpt.com", testkit.PNG)
	srv := testkit.Start(t, testkit.Options{Logos: lg})
	provider(t, srv, "oai", "https://api.openai.com/v1", nil)
	for _, name := range []string{"gpt-6.1-sol", "house-mix"} {
		srv.Admin.Post("/api/pools", map[string]any{"name": name, "members": []any{map[string]any{"provider": "oai", "model": "m-" + name}}}).Expect(201)
	}
	type pool struct {
		Maker        string `json:"maker"`
		MakerGuessed bool   `json:"maker_guessed"`
	}
	var res struct{ Pool pool }

	srv.Admin.Patch("/api/pools/gpt-6.1-sol", map[string]any{"maker": "chatgpt.com"}).Expect(200).JSON(&res)
	if res.Pool.Maker != "chatgpt.com" || res.Pool.MakerGuessed {
		t.Fatalf("pool = %+v", res.Pool)
	}
	if resp := srv.Admin.Get("/api/pools/gpt-6.1-sol/logo").Expect(200); !bytes.Equal(resp.Body, testkit.PNG) {
		t.Fatalf("website logo = %q", resp.Body)
	}
	srv.Admin.Patch("/api/pools/gpt-6.1-sol", map[string]any{"maker": " https://ChatGPT.com/c/123 "}).Expect(200).JSON(&res)
	if res.Pool.Maker != "chatgpt.com" {
		t.Fatalf("pool = %+v", res.Pool)
	}
	srv.Admin.Get("/api/pools/gpt-6.1-sol/logo").Expect(200)

	srv.Admin.Patch("/api/pools/house-mix", map[string]any{"maker": "OpenAI"}).Expect(200).JSON(&res)
	if res.Pool.Maker != "openai" {
		t.Fatalf("pool = %+v", res.Pool)
	}
	if resp := srv.Admin.Get("/api/pools/house-mix/logo").Expect(200); !bytes.Equal(resp.Body, testkit.SVG) {
		t.Fatalf("maker logo = %q", resp.Body)
	}

	srv.Admin.Patch("/api/pools/gpt-6.1-sol", map[string]any{"maker": ""}).Expect(200).JSON(&res)
	if res.Pool.Maker != "openai" || !res.Pool.MakerGuessed {
		t.Fatalf("pool = %+v", res.Pool)
	}

	for _, bad := range []string{"10.0.0.1", "localhost:8080", "user@example.com", "exa mple.com", "https://"} {
		srv.Admin.Patch("/api/pools/house-mix", map[string]any{"maker": bad}).Expect(400)
	}

	srv.Admin.Get("/api/logos?maker=chatgpt.com").Expect(200)
	srv.Admin.Get("/api/logos?maker=https://chatgpt.com/").Expect(200)
	srv.Admin.Get("/api/logos?maker=OpenAI").Expect(200)
	srv.Admin.Get("/api/logos?maker=example.org").Expect(404)
	srv.Admin.Get("/api/logos?maker=10.0.0.1").Expect(400)
}

func TestWithoutLogoSourcesNothingIsFetched(t *testing.T) {
	srv := testkit.Start(t)
	provider(t, srv, "zai", "https://api.z.ai/api/paas/v4", nil)
	srv.Admin.Get("/api/providers/zai/logo").Expect(404)
}

func TestSiteOf(t *testing.T) {
	for in, want := range map[string]string{
		"https://dashscope-intl.aliyuncs.com/compatible-mode/v1": "aliyuncs.com",
		"https://api.openai.com/v1":                              "openai.com",
		"https://openrouter.ai/api/v1":                           "openrouter.ai",
		"https://api.example.co.uk/v1":                           "example.co.uk",
		"http://127.0.0.1:8080/v1":                               "",
		"http://localhost:11434/v1":                              "",
	} {
		if got := logos.SiteOf(in); got != want {
			t.Errorf("SiteOf(%q) = %q, want %q", in, got, want)
		}
	}
}
