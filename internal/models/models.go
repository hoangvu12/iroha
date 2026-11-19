// Package models keeps each Provider's model list (ADR-0003, spec "Models
// and metadata"). An entry has three independent flags: discovered (some
// Endpoint's or key's list names it, discovery.go), added and hidden (the
// Owner's, audited as resource "model", routes.go). An entry is deleted only
// when no flag keeps it.
//
// The list shapes routing in three ways, all applied by Prepare before
// planning: a hidden model is refused, a strict Provider refuses models its
// list lacks, and under per-key discovery the keys whose own list names a
// model are marked as its carriers (planner.Key.Carries) so they are tried
// first. A list never excludes a key, and an unlisted model on a Provider
// that is not strict is forwarded.
//
// Ticket 11 adds metadata to the same entries (reported holds what discovery
// last received for each model); ticket 20 calls Store.Refresh from the
// daily job.
package models

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"log/slog"
	"net/http"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/clock"
	"github.com/hoangvu12/iroha/internal/gatewaykeys"
	"github.com/hoangvu12/iroha/internal/planner"
	"github.com/hoangvu12/iroha/internal/providers"
	"github.com/hoangvu12/iroha/internal/store"
)

// Options are the Store's dependencies.
type Options struct {
	DB         *store.DB
	Log        *slog.Logger
	HTTPClient *http.Client // discovery requests; redirects are never followed
	Providers  *providers.Store
	Keys       *gatewaykeys.Store // authenticates Callers of /providers/{handle}/v1/models
}

// Store keeps model lists.
type Store struct {
	db        *store.DB
	log       *slog.Logger
	clock     clock.Clock
	http      *http.Client
	providers *providers.Store
	keys      *gatewaykeys.Store
}

// New returns a Store.
func New(o Options) *Store {
	hc := *o.HTTPClient
	hc.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &Store{db: o.DB, log: o.Log, clock: o.DB.Clock(), http: &hc, providers: o.Providers, keys: o.Keys}
}

// entryID is the record ID of a Provider's entry for model: derived from
// both, so an entry dropped by discovery and found again keeps its ID.
func entryID(providerID, model string) string {
	sum := sha256.Sum256([]byte(providerID + "\x00" + model))
	return "pm_" + hex.EncodeToString(sum[:10])
}

// errNotOffered is the uniform refusal of a hidden model, or of a model a
// strict Provider's list lacks.
func errNotOffered(handle, model string) *api.Error {
	return api.Errorf(http.StatusNotFound, "model_not_found",
		"Use a model the Provider offers: GET /providers/"+handle+"/v1/models lists them.",
		"Provider %s does not offer the model %q.", handle, model).WithDetails(map[string]string{"provider": handle, "model": model})
}

// Prepare checks, before any Attempt, that model may be asked of Provider
// p: a hidden model is refused, and so is a model missing from a strict
// Provider's list (unless an Endpoint renames it, which names it on
// purpose). Both answer 404 model_not_found. It then marks each key whose
// own discovered list names the wire model of an Endpoint as a carrier, so
// planning tries it first.
func (s *Store) Prepare(ctx context.Context, p *planner.Provider, model string) error {
	var strict, added, hidden, discovered bool
	err := s.db.QueryRowContext(ctx, `SELECT pr.strict, coalesce(m.added, 0), coalesce(m.hidden, 0),
		EXISTS (SELECT 1 FROM provider_model_sources src WHERE src.provider_id = pr.id AND src.model = ?)
		FROM providers pr LEFT JOIN provider_models m ON m.provider_id = pr.id AND m.model = ?
		WHERE pr.id = ?`, model, model, p.ID).Scan(&strict, &added, &hidden, &discovered)
	if err != nil {
		return err
	}
	if hidden {
		return errNotOffered(p.Handle, model)
	}
	if strict && !added && !discovered && !renamed(p, model) {
		return errNotOffered(p.Handle, model)
	}
	return s.markCarriers(ctx, p, model)
}

func renamed(p *planner.Provider, model string) bool {
	for _, e := range p.Endpoints {
		if _, ok := e.Renames[model]; ok {
			return true
		}
	}
	return false
}

// markCarriers sets Key.Carries for the wire models model becomes.
func (s *Store) markCarriers(ctx context.Context, p *planner.Provider, model string) error {
	wire := []any{p.ID, model}
	for i := range p.Endpoints {
		if w := p.Endpoints[i].WireModel(model); !slices.Contains(wire[1:], any(w)) {
			wire = append(wire, w)
		}
	}
	rows, err := s.db.QueryContext(ctx, `SELECT key_id, model FROM provider_model_sources
		WHERE provider_id = ? AND key_id IS NOT NULL AND model IN (?`+strings.Repeat(", ?", len(wire)-2)+`)`, wire...)
	if err != nil {
		return err
	}
	defer rows.Close()
	carries := map[string][]string{}
	for rows.Next() {
		var key, m string
		if err := rows.Scan(&key, &m); err != nil {
			return err
		}
		carries[key] = append(carries[key], m)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for i := range p.Keys {
		k := &p.Keys[i]
		for _, m := range carries[k.ID] {
			if k.Carries == nil {
				k.Carries = map[string]bool{}
			}
			k.Carries[m] = true
		}
	}
	return nil
}

// Model is one entry of a Provider's model list as the admin API shows it.
type Model struct {
	ID           string     `json:"id"`
	Model        string     `json:"model" doc:"The model ID as the Provider names it."`
	Visible      bool       `json:"visible" doc:"true: listed to Callers (discovered or added, and not hidden)."`
	Discovered   bool       `json:"discovered" doc:"true: an Endpoint's or key's discovered list names it."`
	Added        bool       `json:"added" doc:"true: the Owner added it; discovery never removes it."`
	Hidden       bool       `json:"hidden" doc:"true: the Owner hid it; Callers asking for it are refused (404 model_not_found)."`
	Endpoints    []string   `json:"endpoints" doc:"Names of the Endpoints whose discovered list names it."`
	UpstreamKeys []string   `json:"upstream_keys" doc:"Under per-key discovery: names of the keys whose own list names it; they are tried first for it."`
	ModelGaps    []string   `json:"model_gaps" doc:"Names of the keys with a live Model Gap for it (the Provider refused them the model)."`
	DiscoveredAt *time.Time `json:"discovered_at,omitempty" doc:"The last refresh whose lists named it."`
}

// readEntries reads every entry of a Provider that some flag keeps, with
// its sources and live gaps, sorted by model.
func readEntries(ctx context.Context, q querier, providerID string, now time.Time) ([]Model, error) {
	byModel := map[string]*Model{}
	var out []*Model
	rows, err := q.QueryContext(ctx, `SELECT id, model, added, hidden, discovered_at FROM provider_models WHERE provider_id = ?`, providerID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		m := &Model{Endpoints: []string{}, UpstreamKeys: []string{}, ModelGaps: []string{}}
		var at sql.NullInt64
		if err := rows.Scan(&m.ID, &m.Model, &m.Added, &m.Hidden, &at); err != nil {
			rows.Close()
			return nil, err
		}
		if at.Valid {
			t := store.FromMillis(at.Int64)
			m.DiscoveredAt = &t
		}
		byModel[m.Model] = m
		out = append(out, m)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows, err = q.QueryContext(ctx, `SELECT src.model, e.name, coalesce(k.name, '') FROM provider_model_sources src
		JOIN endpoints e ON e.id = src.endpoint_id LEFT JOIN upstream_keys k ON k.id = src.key_id
		WHERE src.provider_id = ? ORDER BY e.created_at, e.rowid, k.created_at, k.rowid`, providerID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var model, ep, key string
		if err := rows.Scan(&model, &ep, &key); err != nil {
			rows.Close()
			return nil, err
		}
		m := byModel[model]
		if m == nil {
			continue
		}
		m.Discovered = true
		if !slices.Contains(m.Endpoints, ep) {
			m.Endpoints = append(m.Endpoints, ep)
		}
		if key != "" && !slices.Contains(m.UpstreamKeys, key) {
			m.UpstreamKeys = append(m.UpstreamKeys, key)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows, err = q.QueryContext(ctx, `SELECT g.model, k.name FROM model_gaps g JOIN upstream_keys k ON k.id = g.key_id
		WHERE k.provider_id = ? AND g.expires_at > ? ORDER BY k.created_at, k.rowid`, providerID, store.Millis(now))
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var model, key string
		if err := rows.Scan(&model, &key); err != nil {
			rows.Close()
			return nil, err
		}
		if m := byModel[model]; m != nil && !slices.Contains(m.ModelGaps, key) {
			m.ModelGaps = append(m.ModelGaps, key)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	list := make([]Model, 0, len(out))
	for _, m := range out {
		if !m.Discovered && !m.Added && !m.Hidden {
			continue // its lists are gone (Endpoint or key deleted); the next refresh deletes it
		}
		m.Visible = (m.Discovered || m.Added) && !m.Hidden
		list = append(list, *m)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Model < list[j].Model })
	return list, nil
}

// readEntry reads one entry of a Provider; ok is false when no flag keeps it.
func readEntry(ctx context.Context, q querier, providerID, model string, now time.Time) (Model, bool, error) {
	list, err := readEntries(ctx, q, providerID, now)
	if err != nil {
		return Model{}, false, err
	}
	for _, m := range list {
		if m.Model == model {
			return m, true, nil
		}
	}
	return Model{ID: entryID(providerID, model), Model: model, Endpoints: []string{}, UpstreamKeys: []string{}, ModelGaps: []string{}}, false, nil
}

// Visible lists the models Callers of a Provider see: discovered or added,
// and not hidden, sorted.
func (s *Store) Visible(ctx context.Context, providerID string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT m.model FROM provider_models m WHERE m.provider_id = ? AND m.hidden = 0
		AND (m.added = 1 OR EXISTS (SELECT 1 FROM provider_model_sources src WHERE src.provider_id = m.provider_id AND src.model = m.model))
		ORDER BY m.model`, providerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var m string
		if err := rows.Scan(&m); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// hiddenSet lists a Provider's hidden models.
func (s *Store) hiddenSet(ctx context.Context, providerID string) (map[string]bool, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT model FROM provider_models WHERE provider_id = ? AND hidden = 1`, providerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var m string
		if err := rows.Scan(&m); err != nil {
			return nil, err
		}
		out[m] = true
	}
	return out, rows.Err()
}

// querier is what reads need from *sql.Tx or *store.DB.
type querier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// pruneEntries deletes a Provider's entries that no flag keeps.
func pruneEntries(ctx context.Context, q querier, providerID string) error {
	_, err := q.ExecContext(ctx, `DELETE FROM provider_models WHERE provider_id = ? AND added = 0 AND hidden = 0
		AND NOT EXISTS (SELECT 1 FROM provider_model_sources src WHERE src.provider_id = provider_models.provider_id AND src.model = provider_models.model)`, providerID)
	return err
}
