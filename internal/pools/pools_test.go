package pools_test

import (
	"testing"

	"github.com/hoangvu12/iroha/internal/pools"
	"github.com/hoangvu12/iroha/internal/testkit"
)

func provider(t *testing.T, srv *testkit.Server, handle string) {
	t.Helper()
	srv.Admin.Post("/api/providers", map[string]any{"handle": handle}).Expect(201)
}

func members(pairs ...string) []any {
	var out []any
	for i := 0; i < len(pairs); i += 2 {
		out = append(out, map[string]any{"provider": pairs[i], "model": pairs[i+1]})
	}
	return out
}

func order(p pools.Pool) string {
	s := ""
	for _, m := range p.Members {
		if s != "" {
			s += ","
		}
		s += m.Provider + "/" + m.Model
		if !m.Enabled {
			s += "(off)"
		}
	}
	return s
}

func TestPoolsAreCreatedByNameAuditedAndRevertible(t *testing.T) {
	srv := testkit.Start(t)
	provider(t, srv, "zai")
	provider(t, srv, "chutes")
	body := map[string]any{"name": "glm-4.6", "members": members("zai", "glm-4.6", "chutes", "zai-org/GLM-4.6")}

	var created pools.PoolResult
	srv.Admin.Post("/api/pools", body).Expect(201).JSON(&created)
	p := created.Pool
	if created.Outcome != "created" || order(p) != "zai/glm-4.6,chutes/zai-org/GLM-4.6" || p.Members[0].Position != 1 ||
		p.Maker != "zhipuai" || !p.MakerGuessed || p.Budget != (pools.Budget{}) {
		t.Fatalf("created = %+v", created)
	}
	// Create-or-update by name: the same call again changes nothing.
	var again pools.PoolResult
	srv.Admin.Post("/api/pools", body).Expect(200).JSON(&again)
	if again.Outcome != "unchanged" || again.AuditEntry != "" || again.Pool.ID != p.ID {
		t.Fatalf("again = %+v", again)
	}

	// Reorder and switch a member off; a dry run changes nothing.
	reorder := map[string]any{"members": []any{
		map[string]any{"provider": "chutes", "model": "zai-org/GLM-4.6"},
		map[string]any{"provider": "zai", "model": "glm-4.6", "enabled": false}}}
	var dry pools.PoolResult
	srv.Admin.Patch("/api/pools/glm-4.6?dry_run=true", reorder).Expect(200).JSON(&dry)
	var got pools.Pool
	srv.Admin.Get("/api/pools/glm-4.6").Expect(200).JSON(&got)
	if !dry.DryRun || order(dry.Pool) != "chutes/zai-org/GLM-4.6,zai/glm-4.6(off)" || order(got) != order(p) {
		t.Fatalf("dry run = %+v, stored %+v", dry, got)
	}
	var edited pools.PoolResult
	srv.Admin.Patch("/api/pools/"+p.ID, reorder).Expect(200).JSON(&edited)
	if edited.Outcome != "updated" || order(edited.Pool) != "chutes/zai-org/GLM-4.6,zai/glm-4.6(off)" {
		t.Fatalf("edited = %+v", edited)
	}
	// Audited, and the revert restores the order and the switch.
	var entries struct {
		Entries []struct{ ID, Action string } `json:"entries"`
	}
	srv.Admin.Get("/api/audit-entries?record=glm-4.6").Expect(200).JSON(&entries)
	if len(entries.Entries) != 2 {
		t.Fatalf("audit entries = %+v", entries)
	}
	srv.Admin.Post("/api/audit-entries/"+edited.AuditEntry+"/revert", nil).Expect(200)
	srv.Admin.Get("/api/pools/glm-4.6").Expect(200).JSON(&got)
	if order(got) != "zai/glm-4.6,chutes/zai-org/GLM-4.6" {
		t.Fatalf("after revert = %+v", got)
	}

	// Budget and maker are the Owner's to set.
	var tuned pools.PoolResult
	srv.Admin.Patch("/api/pools/glm-4.6", map[string]any{"budget": map[string]any{"max_attempts": 5, "first_byte_seconds": 90}, "maker": "z-ai"}).Expect(200).JSON(&tuned)
	if tuned.Pool.Budget != (pools.Budget{MaxAttempts: 5, FirstByteSeconds: 90}) || tuned.Pool.Maker != "z-ai" || tuned.Pool.MakerGuessed {
		t.Fatalf("tuned = %+v", tuned.Pool)
	}
	srv.Admin.Patch("/api/pools/glm-4.6", map[string]any{"budget": map[string]any{"first_byte_seconds": 96}}).Expect(400)

	// Deleting is audited too, and revertible.
	var deleted pools.PoolResult
	srv.Admin.Delete("/api/pools/glm-4.6").Expect(200).JSON(&deleted)
	srv.Admin.Get("/api/pools/glm-4.6").Expect(404)
	srv.Admin.Post("/api/audit-entries/"+deleted.AuditEntry+"/revert", nil).Expect(200)
	srv.Admin.Get("/api/pools/glm-4.6").Expect(200).JSON(&got)
	if got.ID != p.ID || order(got) != "zai/glm-4.6,chutes/zai-org/GLM-4.6" || got.Budget.MaxAttempts != 5 {
		t.Fatalf("restored = %+v", got)
	}
}

func TestPoolNamesNeverCollideAndMembersAreChecked(t *testing.T) {
	srv := testkit.Start(t)
	provider(t, srv, "zai")
	srv.Admin.Post("/api/pools", map[string]any{"name": "glm-4.6", "members": members("zai", "glm-4.6")}).Expect(201)
	srv.Admin.Post("/api/pools", map[string]any{"name": "other"}).Expect(201)

	for _, tc := range []struct {
		method, path string
		body         map[string]any
		status       int
		code         string
	}{
		{"POST", "/api/pools", map[string]any{"name": "GLM-4.6"}, 409, "name_taken"},
		{"PATCH", "/api/pools/other", map[string]any{"name": "Glm-4.6"}, 409, "name_taken"},
		{"POST", "/api/pools", map[string]any{"name": "zai/glm"}, 400, "invalid_request"},
		{"POST", "/api/pools", map[string]any{"name": "x", "members": members("nope", "m")}, 404, "not_found"},
		{"POST", "/api/pools", map[string]any{"name": "x", "members": members("zai", " ")}, 400, "invalid_request"},
		{"POST", "/api/pools", map[string]any{"name": "x", "members": members("zai", "m", "zai", "m")}, 400, "invalid_request"},
		{"POST", "/api/pools", map[string]any{"name": "x", "maker": "Not A Maker"}, 400, "invalid_request"},
	} {
		var resp *testkit.Response
		if tc.method == "POST" {
			resp = srv.Admin.Post(tc.path, tc.body)
		} else {
			resp = srv.Admin.Patch(tc.path, tc.body)
		}
		if e := resp.Expect(tc.status).Err(); e.Code != tc.code {
			t.Fatalf("%s %s %v: %+v", tc.method, tc.path, tc.body, e)
		}
	}
	var list pools.PoolList
	srv.Admin.Get("/api/pools").Expect(200).JSON(&list)
	if len(list.Pools) != 2 || list.Pools[0].Name != "glm-4.6" || list.Pools[1].Name != "other" || len(list.Pools[1].Members) != 0 {
		t.Fatalf("pools = %+v", list)
	}
}

func TestGuessMaker(t *testing.T) {
	for model, want := range map[string]string{
		"claude-sonnet-4.5": "anthropic", "anthropic/claude-opus-4": "anthropic", "gpt-4o": "openai", "o3-mini": "openai",
		"gemini-2.5-pro": "google", "z-ai/glm-4.6": "zhipuai", "qwen3-coder": "alibaba", "deepseek-v3.1": "deepseek",
		"kimi-k2": "moonshotai", "phind-70b": "", "grok-4": "xai", "mystery": "", "o1": "openai", "ollama-thing": "",
	} {
		if got := pools.GuessMaker(model); got != want {
			t.Errorf("GuessMaker(%q) = %q, want %q", model, got, want)
		}
	}
}
