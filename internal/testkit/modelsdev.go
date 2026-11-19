package testkit

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// ModelsDev is a fake models.dev serving api.json (models per models.dev
// provider) and models.json (models keyed <maker>/<model>). Pass its URL as
// Options.ModelsDev.
//
//	md := testkit.NewModelsDev(t)
//	md.SetProvider("anthropic", map[string]any{"claude-x": map[string]any{"limit": map[string]any{"context": 200000}}})
//	srv := testkit.Start(t, testkit.Options{ModelsDev: md.URL})
type ModelsDev struct {
	URL string

	mu        sync.Mutex
	providers map[string]map[string]any // brand -> model ID -> model object
	makers    map[string]any            // "<maker>/<model>" -> model object
	status    int
	hits      int
}

// NewModelsDev starts a fake models.dev with empty catalogs (both files
// answer {}, which Iroha treats as unreadable until something is set).
func NewModelsDev(t testing.TB) *ModelsDev {
	m := &ModelsDev{providers: map[string]map[string]any{}, makers: map[string]any{}}
	srv := httptest.NewServer(http.HandlerFunc(m.serve))
	t.Cleanup(srv.Close)
	m.URL = srv.URL
	return m
}

func (m *ModelsDev) serve(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	m.hits++
	status := m.status
	var body any
	switch r.URL.Path {
	case "/api.json":
		out := map[string]any{}
		for brand, models := range m.providers {
			out[brand] = map[string]any{"id": brand, "models": models}
		}
		body = out
	case "/models.json":
		body = m.makers
	}
	b, _ := json.Marshal(body)
	m.mu.Unlock()
	if status != 0 {
		w.WriteHeader(status)
		return
	}
	if body == nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(b)
}

// SetProvider sets one models.dev provider's models in api.json, by model ID.
func (m *ModelsDev) SetProvider(brand string, models map[string]any) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.providers[brand] = models
}

// SetModel sets one entry of models.json, keyed "<maker>/<model>".
func (m *ModelsDev) SetModel(key string, model any) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.makers[key] = model
}

// Fail makes every answer this status (0: serve again).
func (m *ModelsDev) Fail(status int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.status = status
}

// Hits counts the requests received.
func (m *ModelsDev) Hits() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.hits
}
