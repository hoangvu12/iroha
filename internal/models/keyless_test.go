package models_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/hoangvu12/iroha/internal/testkit"
)

func TestPerKeyDiscoveryReadsAKeylessKeysListWithNoCredential(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	lists := c26ServeKeys(up)
	lists.set("", "free-model")
	lists.set("sk-test-paid", "paid-model")
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme", "discovery": "key"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"url": up.URL(), "shape": "openai-chat"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/keys", map[string]any{"name": "free"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/keys", map[string]any{"name": "paid", "secret": "sk-test-paid"}).Expect(201)

	r := refresh(t, srv)
	if r.Outcome != "ok" || len(r.Lists) != 2 {
		t.Fatalf("refresh = %+v", r)
	}
	var reads []string
	for _, got := range up.Requests() {
		if got.Method != http.MethodGet {
			continue
		}
		if got.Bearer() == "" && (got.Header.Get("Authorization") != "" || got.Header.Get("X-Api-Key") != "" || len(got.Query) != 0) {
			t.Fatalf("the keyless read sent a credential: %v %v", got.Header, got.Query)
		}
		reads = append(reads, "["+strings.TrimPrefix(got.Bearer(), "sk-test-")+"]")
	}
	if strings.Join(reads, ",") != "[],[paid]" && strings.Join(reads, ",") != "[paid],[]" {
		t.Fatalf("list reads %v", reads)
	}
	if l := list(t, srv, ""); names(l) != "free-model,paid-model" {
		t.Fatalf("list = %s", names(l))
	}

	caller := issue(t, srv, "pi", all)
	for range 2 {
		caller.Post("/providers/acme/v1/chat/completions", map[string]any{"model": "free-model", "messages": []any{map[string]any{"role": "user", "content": "hi"}}}).Expect(200)
		if got := up.Last(); got.Header.Get("Authorization") != "" {
			t.Fatalf("free-model went to the keyed key: %v", got.Header)
		}
	}
}
