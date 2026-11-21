package testkit

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

type ModelsDev struct {
	URL string

	mu        sync.Mutex
	providers map[string]map[string]any
	makers    map[string]any
	status    int
	hits      int
}

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

func (m *ModelsDev) SetProvider(brand string, models map[string]any) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.providers[brand] = models
}

func (m *ModelsDev) SetModel(key string, model any) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.makers[key] = model
}

func (m *ModelsDev) Fail(status int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.status = status
}

func (m *ModelsDev) Hits() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.hits
}
