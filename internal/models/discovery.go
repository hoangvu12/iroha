package models

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/hoangvu12/iroha/internal/clock"
	"github.com/hoangvu12/iroha/internal/keystate"
	"github.com/hoangvu12/iroha/internal/logs"
	"github.com/hoangvu12/iroha/internal/modelmeta"
	"github.com/hoangvu12/iroha/internal/planner"
	"github.com/hoangvu12/iroha/internal/providers"
	"github.com/hoangvu12/iroha/internal/shape"
	"github.com/hoangvu12/iroha/internal/store"
)

// Discovery limits.
const (
	discoveryTimeout     = 30 * time.Second // per list, all pages included
	discoveryConcurrency = 5
	maxListBody          = 32 << 20
	maxPages             = 20
	maxReported          = 16 << 10 // a model object larger than this is not kept for metadata
	maxModelLen          = 256
	providerModeTries    = 3 // per-Provider discovery tries this many usable keys before giving up on an Endpoint
)

// Outcomes of one list read and of a whole refresh.
const (
	ListOK      = "ok"
	ListFailed  = "failed"
	ListPlanned = "planned" // dry run: would be read

	RefreshOK      = "ok"
	RefreshPartial = "partial" // some lists failed; their previous models were kept
	RefreshFailed  = "failed"  // every list failed; the previous list is kept
	RefreshSkipped = "skipped" // nothing to read (discovery none, no Endpoint to ask, no usable key)
)

// ListResult is one discovered list: one Endpoint's, or one key's on one
// Endpoint under per-key discovery.
type ListResult struct {
	Endpoint    string `json:"endpoint"`
	UpstreamKey string `json:"upstream_key,omitempty" doc:"The key whose list this is (per-key discovery), or the key the Endpoint was read with (per-Provider discovery)."`
	URL         string `json:"url" doc:"The URL read (without any key in the query)."`
	Outcome     string `json:"outcome" enum:"ok,failed,planned"`
	Status      int    `json:"status,omitempty" doc:"Upstream status of the last page read; 0 when no answer arrived."`
	Found       int    `json:"found" doc:"Models the list named."`
	Error       string `json:"error,omitempty" doc:"Why the list could not be read; the models it named last time are kept."`
}

// RefreshResult is the outcome of one refresh of a Provider's model list.
type RefreshResult struct {
	DryRun      bool         `json:"dry_run" doc:"true: nothing was sent or written; lists says what would be read."`
	Provider    string       `json:"provider"`
	Discovery   string       `json:"discovery" enum:"none,provider,key"`
	Outcome     string       `json:"outcome" enum:"ok,partial,failed,skipped"`
	Summary     string       `json:"summary"`
	Lists       []ListResult `json:"lists"`
	Discovered  int          `json:"discovered" doc:"Models discovered after the refresh."`
	Added       []string     `json:"added" doc:"Models discovered now that were not before."`
	Removed     []string     `json:"removed" doc:"Models no longer discovered (entries the Owner added or hid stay)."`
	GapsCleared int          `json:"model_gaps_cleared" doc:"Model Gaps cleared because the key's own list names the model (per-key discovery)."`
	ModelsDev   string       `json:"models_dev,omitempty" enum:"ok,stale,unavailable,off" doc:"How the list's models were looked up in models.dev for metadata: ok; stale (models.dev unreachable, its last catalog used); unavailable (never read: earlier lookups kept); off. It never changes the outcome. Absent on a dry run."`
}

// listJob is one list to read.
type listJob struct {
	ep   *planner.Endpoint
	key  *planner.Key   // per-key: whose list; nil under per-Provider discovery
	try  []*planner.Key // per-Provider: keys to read it with, in order (none: keyless)
	url  string
	res  ListResult
	got  []entry
	used *planner.Key
}

// Refresh reads the model lists of the Provider addressed by handle or ID
// and stores what they name. Lists that fail keep the models they named
// before; every list is logged as a discovery event, the whole refresh as
// one more. Model Gaps a key's own list contradicts are cleared. With dry,
// nothing is sent or written. A jobs.Job may call it directly.
func (s *Store) Refresh(ctx context.Context, provider string, dry bool) (RefreshResult, error) {
	rt, err := s.providers.ResolveRouting(ctx, provider)
	if err != nil {
		return RefreshResult{}, err
	}
	res := RefreshResult{DryRun: dry, Provider: rt.Handle, Discovery: rt.Discovery, Lists: []ListResult{}, Added: []string{}, Removed: []string{}}
	jobs := plan(&rt)
	if len(jobs) == 0 {
		res.Outcome = RefreshSkipped
		res.Summary = skipReason(&rt)
		if !dry {
			if err := s.saveSkipped(ctx, &rt, res); err != nil {
				return res, err
			}
			if res.ModelsDev, err = s.supplement(context.WithoutCancel(ctx), rt.ID, nil); err != nil {
				return res, err
			}
		}
		return res, nil
	}
	if dry {
		for _, j := range jobs {
			j.res.Outcome = ListPlanned
			res.Lists = append(res.Lists, j.res)
		}
		res.Summary = fmt.Sprintf("Would read %d model lists.", len(jobs))
		return res, nil
	}
	ctx = context.WithoutCancel(ctx) // a started refresh finishes and records what it read
	s.readAll(ctx, &rt, jobs)
	gaps, err := s.apply(ctx, &rt, jobs, &res)
	if err != nil {
		return res, err
	}
	keystate.LogGaps(s.log, gaps)
	if res.ModelsDev, err = s.supplement(ctx, rt.ID, nil); err != nil {
		return res, err
	}
	for _, j := range jobs {
		attrs := []any{logs.Kind(logs.KindDiscovery), logs.Provider(rt.Handle), "endpoint", j.ep.Name, "outcome", j.res.Outcome, "found", j.res.Found}
		if j.res.UpstreamKey != "" {
			attrs = append(attrs, "upstream_key", j.res.UpstreamKey)
		}
		if j.res.Status != 0 {
			attrs = append(attrs, "status", j.res.Status)
		}
		if j.res.Outcome == ListFailed {
			s.log.Warn("model list could not be read", append(attrs, "error", j.res.Error)...)
		} else {
			s.log.Info("model list read", attrs...)
		}
	}
	level := s.log.Info
	if res.Outcome == RefreshFailed || res.Outcome == RefreshPartial {
		level = s.log.Warn
	}
	level("model list refreshed", logs.Kind(logs.KindDiscovery), logs.Provider(rt.Handle), "outcome", res.Outcome,
		"found", res.Discovered, "added", len(res.Added), "removed", len(res.Removed), "model_gaps_cleared", res.GapsCleared, "summary", res.Summary)
	return res, nil
}

// usable reports whether discovery may use key k.
func usable(k *planner.Key) bool { return !k.Disabled && !k.Invalid }

// discoveryURL is where Endpoint e's list is read, or "" for none.
func discoveryURL(rt *providers.Routing, e *planner.Endpoint) string {
	switch d := rt.DiscoveryURLs[e.ID]; d {
	case providers.NoDiscovery:
		return ""
	case "":
		return strings.TrimRight(e.URL, "/") + "/models"
	default:
		return d
	}
}

// plan lists the lists a refresh reads.
func plan(rt *providers.Routing) []*listJob {
	var out []*listJob
	if rt.Discovery == providers.DiscoveryNone {
		return nil
	}
	for i := range rt.Endpoints {
		ep := &rt.Endpoints[i]
		u := discoveryURL(rt, ep)
		if u == "" {
			continue
		}
		if rt.Discovery == providers.DiscoveryKey {
			for ki := range rt.Keys {
				k := &rt.Keys[ki]
				if usable(k) && k.Allows(ep.ID) {
					out = append(out, &listJob{ep: ep, key: k, url: u, res: ListResult{Endpoint: ep.Name, UpstreamKey: k.Name, URL: u}})
				}
			}
			continue
		}
		j := &listJob{ep: ep, url: u, res: ListResult{Endpoint: ep.Name, URL: u}}
		allowed := 0
		for ki := range rt.Keys {
			k := &rt.Keys[ki]
			if !k.Allows(ep.ID) {
				continue
			}
			allowed++
			if usable(k) && len(j.try) < providerModeTries {
				j.try = append(j.try, k)
			}
		}
		if allowed > 0 && len(j.try) == 0 {
			continue // every key that may use it is disabled or invalid
		}
		out = append(out, j)
	}
	return out
}

func skipReason(rt *providers.Routing) string {
	switch {
	case rt.Discovery == providers.DiscoveryNone:
		return "Discovery is off for this Provider (discovery none); its list holds only models the Owner added."
	case len(rt.Endpoints) == 0:
		return "The Provider has no Endpoint to read a model list from."
	}
	for i := range rt.Endpoints {
		if discoveryURL(rt, &rt.Endpoints[i]) != "" {
			return "No Upstream Key can read the model lists: every key is disabled, invalid or restricted to other Endpoints."
		}
	}
	return "Every Endpoint has discovery_url none."
}

// readAll reads every list, a few at a time.
func (s *Store) readAll(ctx context.Context, rt *providers.Routing, jobs []*listJob) {
	sem := make(chan struct{}, discoveryConcurrency)
	var wg sync.WaitGroup
	for _, j := range jobs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			s.read(ctx, rt, j)
		}()
	}
	wg.Wait()
}

// read reads one list; under per-Provider discovery it tries the next key
// when one fails.
func (s *Store) read(ctx context.Context, rt *providers.Routing, j *listJob) {
	keys := j.try
	switch {
	case j.key != nil:
		keys = []*planner.Key{j.key}
	case len(keys) == 0:
		keys = []*planner.Key{{}} // keyless: the Provider has no key that may use this Endpoint
	}
	for _, k := range keys {
		got, status, err := s.fetch(ctx, rt, j.ep, k, j.url)
		j.res.Status = status
		if j.key == nil && k.ID != "" {
			j.res.UpstreamKey = k.Name
		}
		if err == nil {
			j.got, j.used, j.res.Outcome, j.res.Found, j.res.Error = got, k, ListOK, len(got), ""
			return
		}
		j.res.Outcome, j.res.Error = ListFailed, scrub(err.Error(), k.Secret) // an answer may echo the key
	}
}

// fetch reads every page of one list with key k (an empty key sends no credential).
func (s *Store) fetch(ctx context.Context, rt *providers.Routing, ep *planner.Endpoint, k *planner.Key, raw string) ([]entry, int, error) {
	ctx, cancel := clock.WithTimeout(ctx, s.clock, discoveryTimeout)
	defer cancel()
	var all []entry
	seen := map[string]bool{}
	next := raw
	status := 0
	for page := 0; page < maxPages && next != ""; page++ {
		req, err := discoveryRequest(ctx, ep, k, next)
		if err != nil {
			return nil, 0, err
		}
		resp, err := s.http.Do(req)
		if err != nil {
			if ctx.Err() != nil {
				return nil, 0, fmt.Errorf("no answer within %s", discoveryTimeout)
			}
			return nil, 0, fmt.Errorf("the request failed: %s", scrub(err.Error(), k.Secret))
		}
		body, err := io.ReadAll(io.LimitReader(resp.Body, maxListBody+1))
		resp.Body.Close()
		status = resp.StatusCode
		if err != nil {
			return nil, status, fmt.Errorf("the answer could not be read: %s", scrub(err.Error(), k.Secret))
		}
		if resp.StatusCode < 200 || resp.StatusCode > 299 {
			// Scrubbed before cutting, so no part of an echoed key is left.
			return nil, status, fmt.Errorf("HTTP %d: %s", resp.StatusCode, snippet([]byte(scrub(string(body), k.Secret))))
		}
		if len(body) > maxListBody {
			return nil, status, fmt.Errorf("the answer is larger than %d MiB", maxListBody>>20)
		}
		list, cont, err := parseList(body)
		if err != nil {
			return nil, status, err
		}
		for _, e := range list {
			if !seen[e.id] {
				seen[e.id] = true
				all = append(all, e)
			}
		}
		next = ""
		if cont != nil {
			next = nextPage(raw, cont)
		}
	}
	return all, status, nil
}

// discoveryRequest builds the GET of one page: the Endpoint's static
// headers, then the key per the Endpoint's auth style (as on an Attempt).
func discoveryRequest(ctx context.Context, ep *planner.Endpoint, k *planner.Key, raw string) (*http.Request, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("the discovery URL does not parse: %w", err)
	}
	send := !k.Keyless(ep)
	if send && ep.AuthStyle == planner.AuthQuery {
		q := u.Query()
		q.Set(ep.AuthParam, k.Secret)
		u.RawQuery = q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("the discovery URL does not make a request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	if ep.Shape == shape.AnthropicMessages {
		req.Header.Set("Anthropic-Version", "2023-06-01")
	}
	for name, v := range ep.StaticHeaders {
		req.Header.Set(name, v)
	}
	if send {
		switch ep.AuthStyle {
		case "", planner.AuthBearer:
			req.Header.Set("Authorization", "Bearer "+k.Secret)
		case planner.AuthXAPIKey:
			req.Header.Set("X-Api-Key", k.Secret)
		case planner.AuthHeader:
			req.Header.Set(ep.AuthParam, k.Secret)
		}
	}
	return req, nil
}

// pageToken says how to ask for the next page: Anthropic's after_id or
// Gemini's pageToken.
type pageToken struct{ param, value string }

func nextPage(raw string, t *pageToken) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	q := u.Query()
	q.Set(t.param, t.value)
	u.RawQuery = q.Encode()
	return u.String()
}

// entry is one model a list names.
type entry struct {
	id  string
	raw json.RawMessage // the model's object, or nil
}

var errNoList = errors.New("the answer has no data or models array")

// parseList reads a model list answer: an object with a data or models
// array (or a bare array), whose items are objects with an id (or Gemini's
// name "models/<id>", or model) or plain strings. It also says how to ask
// for the next page, if the answer has one.
func parseList(body []byte) ([]entry, *pageToken, error) {
	body = bytes.TrimSpace(body)
	var items []json.RawMessage
	var next *pageToken
	switch {
	case len(body) > 0 && body[0] == '[':
		if json.Unmarshal(body, &items) != nil {
			return nil, nil, errNoList
		}
	case len(body) > 0 && body[0] == '{':
		var obj struct {
			Data          []json.RawMessage `json:"data"`
			Models        []json.RawMessage `json:"models"`
			HasMore       bool              `json:"has_more"`
			LastID        string            `json:"last_id"`
			NextPageToken string            `json:"nextPageToken"`
		}
		var keys map[string]json.RawMessage
		if json.Unmarshal(body, &keys) != nil {
			return nil, nil, fmt.Errorf("the answer is not JSON: %s", snippet(body))
		}
		_, hasData := keys["data"]
		_, hasModels := keys["models"]
		if !hasData && !hasModels {
			return nil, nil, errNoList
		}
		if err := json.Unmarshal(body, &obj); err != nil {
			return nil, nil, errNoList
		}
		items = obj.Data
		if !hasData || (len(items) == 0 && len(obj.Models) > 0) {
			items = obj.Models
		}
		switch {
		case obj.HasMore && obj.LastID != "":
			next = &pageToken{"after_id", obj.LastID}
		case obj.NextPageToken != "":
			next = &pageToken{"pageToken", obj.NextPageToken}
		}
	default:
		return nil, nil, fmt.Errorf("the answer is not JSON: %s", snippet(body))
	}
	out := []entry{}
	seen := map[string]bool{}
	for _, it := range items {
		e, ok := parseItem(it)
		if !ok || seen[e.id] {
			continue
		}
		seen[e.id] = true
		out = append(out, e)
	}
	return out, next, nil
}

func parseItem(raw json.RawMessage) (entry, bool) {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return checkID(s, nil)
	}
	var obj struct {
		ID    *string `json:"id"`
		Name  *string `json:"name"`
		Model *string `json:"model"`
	}
	if json.Unmarshal(raw, &obj) != nil {
		return entry{}, false
	}
	keep := raw
	if len(keep) > maxReported {
		keep = nil
	}
	switch {
	case obj.ID != nil && strings.TrimSpace(*obj.ID) != "":
		return checkID(*obj.ID, keep)
	case obj.Name != nil && strings.TrimSpace(*obj.Name) != "":
		return checkID(strings.TrimPrefix(strings.TrimSpace(*obj.Name), "models/"), keep)
	case obj.Model != nil:
		return checkID(*obj.Model, keep)
	}
	return entry{}, false
}

func checkID(s string, raw json.RawMessage) (entry, bool) {
	s = strings.TrimSpace(s)
	if s == "" || len(s) > maxModelLen || strings.ContainsFunc(s, func(r rune) bool { return r < 0x20 || r == 0x7f }) {
		return entry{}, false
	}
	return entry{id: s, raw: raw}, true
}

// snippet is the start of a body, for an error message.
func snippet(b []byte) string {
	s := strings.Join(strings.Fields(string(b)), " ")
	if len(s) > 200 {
		s = s[:200] + "..."
	}
	if s == "" {
		s = "(empty body)"
	}
	return s
}

// scrub keeps a secret out of an error text (a query-style key is in the URL).
func scrub(s, secret string) string {
	if secret == "" {
		return s
	}
	return strings.ReplaceAll(strings.ReplaceAll(s, url.QueryEscape(secret), "***"), secret, "***")
}

// keyRef is how a stored list names its key: NULL under per-Provider discovery.
func keyRef(j *listJob) any {
	if j.key == nil {
		return nil
	}
	return j.key.ID
}

// apply stores what the lists named, in one transaction, and fills res.
func (s *Store) apply(ctx context.Context, rt *providers.Routing, jobs []*listJob, res *RefreshResult) ([]keystate.GapEvent, error) {
	now := s.clock.Now().UTC()
	var gaps []keystate.GapEvent
	err := s.db.Tx(ctx, func(tx *sql.Tx) error {
		gaps, res.GapsCleared = nil, 0
		before, err := discoveredSet(ctx, tx, rt.ID)
		if err != nil {
			return err
		}
		// Forget lists that are no longer read at all: Endpoints with
		// discovery none, keys now restricted elsewhere, the other mode's rows.
		if err := dropStaleLists(ctx, tx, rt); err != nil {
			return err
		}
		reported := map[string]bool{}
		for _, j := range jobs {
			if j.res.Outcome != ListOK {
				continue
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM provider_model_sources WHERE provider_id = ? AND endpoint_id = ? AND ifnull(key_id, '') = ?`,
				rt.ID, j.ep.ID, keyIDOrEmpty(j)); err != nil {
				return err
			}
			for _, e := range j.got {
				if _, err := tx.ExecContext(ctx, `INSERT INTO provider_model_sources (provider_id, endpoint_id, key_id, model, seen_at) VALUES (?, ?, ?, ?, ?)`,
					rt.ID, j.ep.ID, keyRef(j), e.id, store.Millis(now)); err != nil {
					return err
				}
				// The first list (in Endpoint and key order) whose object says
				// something of the model wins; an object that says nothing
				// (a bare {"id": ...}) keeps the facts reported before.
				raw := ""
				if e.raw != nil && !reported[e.id] && !modelmeta.Normalize(e.raw).IsZero() {
					raw, reported[e.id] = string(e.raw), true
				}
				if _, err := tx.ExecContext(ctx, `INSERT INTO provider_models (id, provider_id, model, reported, discovered_at) VALUES (?, ?, ?, ?, ?)
					ON CONFLICT (id) DO UPDATE SET discovered_at = excluded.discovered_at,
					reported = CASE WHEN excluded.reported != '' THEN excluded.reported ELSE provider_models.reported END`,
					entryID(rt.ID, e.id), rt.ID, e.id, raw, store.Millis(now)); err != nil {
					return err
				}
			}
			if j.key != nil {
				evs, err := clearListedGaps(ctx, tx, rt, j, now)
				if err != nil {
					return err
				}
				gaps = append(gaps, evs...)
			}
		}
		for _, g := range gaps {
			if g.Op == keystate.GapCleared {
				res.GapsCleared++
			}
		}
		if err := pruneEntries(ctx, tx, rt.ID); err != nil {
			return err
		}
		after, err := discoveredSet(ctx, tx, rt.ID)
		if err != nil {
			return err
		}
		res.Added, res.Removed = diff(after, before), diff(before, after)
		res.Discovered = len(after)
		ok, failed := 0, 0
		res.Lists = res.Lists[:0]
		for _, j := range jobs {
			res.Lists = append(res.Lists, j.res)
			if j.res.Outcome == ListOK {
				ok++
			} else {
				failed++
			}
		}
		switch {
		case failed == 0:
			res.Outcome = RefreshOK
			res.Summary = fmt.Sprintf("Read %d model lists: %d models, %d new, %d gone.", ok, res.Discovered, len(res.Added), len(res.Removed))
		case ok == 0:
			res.Outcome = RefreshFailed
			res.Summary = fmt.Sprintf("Every model list failed (%d); the previous list is kept. First error: %s", failed, firstError(jobs))
		default:
			res.Outcome = RefreshPartial
			res.Summary = fmt.Sprintf("Read %d of %d model lists (the others kept their previous models): %d models, %d new, %d gone. First error: %s",
				ok, ok+failed, res.Discovered, len(res.Added), len(res.Removed), firstError(jobs))
		}
		return saveRefresh(ctx, tx, rt.ID, now, res.Outcome, res.Summary)
	})
	return gaps, err
}

func keyIDOrEmpty(j *listJob) string {
	if j.key == nil {
		return ""
	}
	return j.key.ID
}

func firstError(jobs []*listJob) string {
	for _, j := range jobs {
		if j.res.Outcome == ListFailed {
			who := j.res.Endpoint
			if j.res.UpstreamKey != "" {
				who += " with " + j.res.UpstreamKey
			}
			return who + ": " + j.res.Error
		}
	}
	return ""
}

// clearListedGaps clears the Model Gaps of the list's key for the models
// its list names: the Provider says the key can call them now.
func clearListedGaps(ctx context.Context, tx *sql.Tx, rt *providers.Routing, j *listJob, now time.Time) ([]keystate.GapEvent, error) {
	var out []keystate.GapEvent
	for _, e := range j.got {
		if _, ok := j.key.ModelGaps[e.id]; !ok {
			continue
		}
		evs, err := keystate.ClearGaps(ctx, tx, keystate.Key{ID: j.key.ID, Name: j.key.Name, Provider: rt.Handle}, e.id,
			"The key's discovered model list names the model.", now, nil)
		if err != nil {
			return nil, err
		}
		out = append(out, evs...)
	}
	return out, nil
}

// dropStaleLists deletes stored lists no refresh of the Provider's current
// configuration reads: lists of Endpoints with discovery none, lists of the
// other discovery mode, and per-key lists of keys now restricted to other
// Endpoints. Lists of keys skipped for their Key State are kept.
func dropStaleLists(ctx context.Context, tx *sql.Tx, rt *providers.Routing) error {
	for i := range rt.Endpoints {
		ep := &rt.Endpoints[i]
		if discoveryURL(rt, ep) == "" {
			if _, err := tx.ExecContext(ctx, `DELETE FROM provider_model_sources WHERE provider_id = ? AND endpoint_id = ?`, rt.ID, ep.ID); err != nil {
				return err
			}
			continue
		}
		if rt.Discovery == providers.DiscoveryKey {
			if _, err := tx.ExecContext(ctx, `DELETE FROM provider_model_sources WHERE provider_id = ? AND endpoint_id = ? AND key_id IS NULL`, rt.ID, ep.ID); err != nil {
				return err
			}
			for ki := range rt.Keys {
				if k := &rt.Keys[ki]; !k.Allows(ep.ID) {
					if _, err := tx.ExecContext(ctx, `DELETE FROM provider_model_sources WHERE provider_id = ? AND endpoint_id = ? AND key_id = ?`, rt.ID, ep.ID, k.ID); err != nil {
						return err
					}
				}
			}
		} else if _, err := tx.ExecContext(ctx, `DELETE FROM provider_model_sources WHERE provider_id = ? AND endpoint_id = ? AND key_id IS NOT NULL`, rt.ID, ep.ID); err != nil {
			return err
		}
	}
	return nil
}

// discoveredSet is the set of models some stored list names.
func discoveredSet(ctx context.Context, q querier, providerID string) (map[string]bool, error) {
	rows, err := q.QueryContext(ctx, `SELECT DISTINCT model FROM provider_model_sources WHERE provider_id = ?`, providerID)
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

// diff lists the members of a missing from b, sorted.
func diff(a, b map[string]bool) []string {
	out := []string{}
	for m := range a {
		if !b[m] {
			out = append(out, m)
		}
	}
	sort.Strings(out)
	return out
}

func saveRefresh(ctx context.Context, q querier, providerID string, at time.Time, outcome, summary string) error {
	_, err := q.ExecContext(ctx, `INSERT INTO model_refreshes (provider_id, refreshed_at, outcome, summary) VALUES (?, ?, ?, ?)
		ON CONFLICT (provider_id) DO UPDATE SET refreshed_at = excluded.refreshed_at, outcome = excluded.outcome, summary = excluded.summary`,
		providerID, store.Millis(at), outcome, summary)
	return err
}

func (s *Store) saveSkipped(ctx context.Context, rt *providers.Routing, res RefreshResult) error {
	if err := s.db.Tx(ctx, func(tx *sql.Tx) error {
		return saveRefresh(ctx, tx, rt.ID, s.clock.Now().UTC(), res.Outcome, res.Summary)
	}); err != nil {
		return err
	}
	s.log.Info("model list refresh skipped", logs.Kind(logs.KindDiscovery), logs.Provider(rt.Handle), "outcome", res.Outcome, "summary", res.Summary)
	return nil
}

// LastRefresh is the latest refresh of a Provider's model list.
type LastRefresh struct {
	At      time.Time `json:"at"`
	Outcome string    `json:"outcome" enum:"ok,partial,failed,skipped"`
	Summary string    `json:"summary"`
}

// LastRefreshOf reads the latest refresh of a Provider (nil: never refreshed).
// The daily job (ticket 20) uses it to find Providers that are due.
func (s *Store) LastRefreshOf(ctx context.Context, providerID string) (*LastRefresh, error) {
	return lastRefresh(ctx, s.db, providerID)
}

func lastRefresh(ctx context.Context, q querier, providerID string) (*LastRefresh, error) {
	var r LastRefresh
	var at int64
	err := q.QueryRowContext(ctx, `SELECT refreshed_at, outcome, summary FROM model_refreshes WHERE provider_id = ?`, providerID).Scan(&at, &r.Outcome, &r.Summary)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	r.At = store.FromMillis(at)
	return &r, nil
}

// ResetResult is the outcome of forgetting a Provider's discovered models.
type ResetResult struct {
	DryRun   bool     `json:"dry_run"`
	Provider string   `json:"provider"`
	Removed  []string `json:"removed" doc:"Models that left the list: discovered only, neither added nor hidden by the Owner."`
	Kept     int      `json:"kept" doc:"Entries kept because the Owner added or hid them."`
}

// Reset forgets every discovered list of a Provider. Entries the Owner
// added or hid stay; the Provider, its Endpoints, keys and every Gateway Key
// scope naming it are untouched. The next refresh discovers afresh.
func (s *Store) Reset(ctx context.Context, provider string, dry bool) (ResetResult, error) {
	rt, err := s.providers.ResolveRouting(ctx, provider)
	if err != nil {
		return ResetResult{}, err
	}
	res := ResetResult{DryRun: dry, Provider: rt.Handle, Removed: []string{}}
	errDry := errors.New("dry run")
	err = s.db.Tx(ctx, func(tx *sql.Tx) error {
		before, err := discoveredSet(ctx, tx, rt.ID)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM provider_model_sources WHERE provider_id = ?`, rt.ID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE provider_models SET discovered_at = NULL, reported = '' WHERE provider_id = ?`, rt.ID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM model_refreshes WHERE provider_id = ?`, rt.ID); err != nil {
			return err
		}
		if err := pruneEntries(ctx, tx, rt.ID); err != nil {
			return err
		}
		rows, err := tx.QueryContext(ctx, `SELECT model FROM provider_models WHERE provider_id = ?`, rt.ID)
		if err != nil {
			return err
		}
		kept := map[string]bool{}
		for rows.Next() {
			var m string
			if err := rows.Scan(&m); err != nil {
				rows.Close()
				return err
			}
			kept[m] = true
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		res.Removed, res.Kept = diff(before, kept), len(kept)
		if dry {
			return errDry
		}
		return nil
	})
	if errors.Is(err, errDry) {
		err = nil
	}
	if err != nil {
		return res, err
	}
	if !dry {
		s.log.Info("discovered models reset", logs.Kind(logs.KindDiscovery), logs.Provider(rt.Handle), "outcome", "reset",
			"removed", len(res.Removed), "kept", res.Kept)
	}
	return res, nil
}
