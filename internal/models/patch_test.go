package models_test

import (
	"encoding/json"
	"testing"

	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/models"
	"github.com/hoangvu12/iroha/internal/testkit"
)

func overrides(t *testing.T, srv *testkit.Server, model string) string {
	t.Helper()
	var m models.Model
	srv.Admin.Get("/api/providers/acme/models/" + model).Expect(200).JSON(&m)
	b, _ := json.Marshal(m.Overrides)
	return string(b)
}

func TestMetadataPatchChangesOnlyTheFieldsItNames(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, up.URL(), nil)
	srv.Admin.Post("/api/providers/acme/models/bulk", map[string]any{"items": []any{
		map[string]any{"model": "a", "metadata": map[string]any{"context_length": 1000, "chat": "ok"}},
		map[string]any{"model": "b", "metadata": map[string]any{"reasoning": true}},
	}}).OK()
	srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": "b", "metadata": map[string]any{"reasoning": true, "max_output_tokens": 64000}}).OK()

	var res audit.BulkResult[models.Model]
	srv.Admin.Post("/api/providers/acme/models/bulk", map[string]any{"items": []any{
		map[string]any{"model": "a", "metadata_patch": map[string]any{"context_length": 2000, "chat": nil}},
		map[string]any{"model": "b", "metadata_patch": map[string]any{"context_length": 2000, "chat": nil}},
	}}).OK().JSON(&res)
	if res.Succeeded != 2 {
		t.Fatalf("bulk = %+v", res)
	}
	if got := overrides(t, srv, "a"); got != `{"context_length":2000}` {
		t.Errorf("a = %s", got)
	}
	if got := overrides(t, srv, "b"); got != `{"context_length":2000,"max_output_tokens":64000,"reasoning":true}` {
		t.Errorf("b = %s (max_output_tokens set elsewhere must survive)", got)
	}

	srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": "c", "metadata_patch": map[string]any{"chat": "unsupported"}}).Expect(201)
	if got := overrides(t, srv, "c"); got != `{"chat":"unsupported"}` {
		t.Errorf("c = %s", got)
	}

	srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": "b", "metadata_patch": map[string]any{"context_length": -1}}).Expect(400)
	srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": "b", "metadata_patch": map[string]any{"reasoning": false, "reasoning_levels": []string{"high"}}}).Expect(400)
	srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": "b", "metadata_patch": map[string]any{"colour": "red"}}).Expect(400)
	srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": "b", "metadata_patch": []any{}}).Expect(400)
	srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": "b", "metadata": map[string]any{}, "metadata_patch": map[string]any{}}).Expect(400)

	srv.Admin.Post("/api/audit-entries/"+res.AuditEntry+"/revert", nil).OK()
	if got := overrides(t, srv, "b"); got != `{"max_output_tokens":64000,"reasoning":true}` {
		t.Errorf("b after revert = %s", got)
	}
}
