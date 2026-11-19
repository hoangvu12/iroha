package testchat

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/gatewaykeys"
	"github.com/hoangvu12/iroha/internal/models"
	"github.com/hoangvu12/iroha/internal/requests"
	"github.com/hoangvu12/iroha/internal/shape"
	"github.com/hoangvu12/iroha/internal/store"
)

const tag = "Test"

// ModelChoices is the answer of GET /api/test/models.
type ModelChoices struct {
	Total     int              `json:"total" doc:"Pools and models the caller may use, before the search."`
	Matched   int              `json:"matched" doc:"How many match q."`
	Pools     []ModelChoice    `json:"pools" doc:"Matching Model Pools, by name."`
	Providers []ProviderChoice `json:"providers" doc:"Matching models grouped by Provider, by handle."`
	Truncated bool             `json:"truncated" doc:"true when more matched than limit; the counts still cover them all."`
	Suggested string           `json:"suggested,omitempty" doc:"With prefer naming a Provider: the model to start a test of it with (<provider>/<model>), the one it served most in the last 7 days, else its first listed. Ignores q and limit."`
}

// ModelChoice is one Pool or Provider model the chat can send to.
type ModelChoice struct {
	ID              string   `json:"id" doc:"The name to send: a Pool name or <provider>/<model>."`
	Model           string   `json:"model" doc:"The Pool name, or the model on its Provider."`
	ContextLength   *int64   `json:"context_length,omitempty"`
	Reasoning       *bool    `json:"reasoning,omitempty"`
	ReasoningLevels []string `json:"reasoning_levels,omitempty"`
	Maker           string   `json:"maker,omitempty" doc:"Pools: the model's maker."`
}

// ProviderChoice is one Provider's matching models.
type ProviderChoice struct {
	Provider string        `json:"provider" doc:"Provider handle."`
	Matched  int           `json:"matched" doc:"Models of this Provider matching q (models may hold fewer when the answer was truncated)."`
	Models   []ModelChoice `json:"models"`
}

// Routes are the test chat's read routes: the model picker's search and
// the snippets. Sending is POST /api/test (the Gateway's TestRoutes).
func Routes(ms *models.Store, keys *gatewaykeys.Store, db *store.DB) []api.Route {
	return []api.Route{
		{
			Method: http.MethodGet, Path: "/api/test/models", Tag: tag,
			Summary: "Search the Model Pools and models a test can send to, Pools first",
			Description: "Exactly what GET /v1/models would list for the Gateway Key named by as (everything without as): Pools by name, " +
				"then each enabled Provider's visible models as <provider>/<model>. q matches IDs case-insensitively; several words must all match. " +
				"The answer holds at most limit entries but counts every match, so a picker can say \"38 of 1,326\".",
			Query: []api.Param{
				{Name: "q", Description: "Words every ID must contain."},
				{Name: "as", Description: "A Gateway Key (name or ID): only what it may use."},
				{Name: "limit", Type: "integer", Description: "Most entries to return, 1 to 2000. Default 300."},
				{Name: "prefer", Description: "<provider>/ (or <provider>/<model>) or a Pool name to list first, as when a test starts from it."},
			},
			Response: ModelChoices{},
			Handle: func(c *api.Call) (any, error) {
				limit := 300
				if s := c.Query("limit"); s != "" {
					n, err := strconv.Atoi(s)
					if err != nil || n < 1 || n > 2000 {
						return nil, api.BadRequest("Use a limit from 1 to 2000.", "limit %q is not allowed.", s)
					}
					limit = n
				}
				caller := gatewaykeys.Unrestricted(CallerName)
				if as := c.Query("as"); as != "" {
					var err error
					if caller, err = keys.CallerOf(c.R.Context(), as); err != nil {
						return nil, err
					}
				}
				all, err := ms.CallerModels(c.R.Context(), caller)
				if err != nil {
					return nil, err
				}
				prefer := c.Query("prefer")
				out := search(all, c.Query("q"), limit, prefer)
				if handle, _, ok := strings.Cut(prefer, "/"); ok && handle != "" {
					served, err := requests.ServedModels(c.R.Context(), db, handle, db.Clock().Now().Add(-suggestWindow))
					if err != nil {
						return nil, err
					}
					out.Suggested = suggest(all, handle, served)
				}
				return out, nil
			},
		},
		{
			Method: http.MethodGet, Path: "/api/test/snippets", Tag: tag,
			Summary: "Write curl, Python and TypeScript snippets sending a test's request to the Gateway",
			Description: "The snippets send what POST /api/test would send for these settings, but as a Caller: to the global route of the Shape, " +
				"with a Gateway Key (the secret of as when given, else read from the IROHA_KEY environment variable). " +
				"Pinning to an Upstream Key or Endpoint is test-only and not carried.",
			Query: []api.Param{
				{Name: "model", Required: true, Description: "A Pool name or <provider>/<model>."},
				{Name: "shape", Enum: []string{"openai-chat", "openai-responses", "anthropic-messages", "gemini"}, Description: "Default openai-chat."},
				{Name: "prompt", Description: "The user message. Default: a request for a short reply."},
				{Name: "system", Description: "A system prompt."},
				{Name: "reasoning", Enum: []string{"off", "low", "medium", "high"}},
				{Name: "tool_check", Type: "boolean", Description: "Offer the test tool get_weather."},
				{Name: "stream", Type: "boolean", Description: "Default true."},
				{Name: "as", Description: "A Gateway Key (name or ID) whose secret the snippets use."},
				{Name: "upstream_key", Description: "A pinned Upstream Key; accepted and ignored (a Caller cannot pin)."},
				{Name: "endpoint", Description: "A pinned Endpoint; accepted and ignored (a Caller cannot pin)."},
				{Name: "base_url", Description: "Iroha's public base URL. Default: the scheme and host this call reached."},
			},
			Response: Snippets{},
			Handle: func(c *api.Call) (any, error) {
				s := Send{Model: c.Query("model"), Shape: shape.Shape(c.Query("shape")), System: c.Query("system"), Reasoning: c.Query("reasoning"),
					UpstreamKey: c.Query("upstream_key"), Endpoint: c.Query("endpoint"), As: c.Query("as")}
				if p := c.Query("prompt"); p != "" {
					s.Messages = []Message{{Role: "user", Content: p}}
				}
				var err error
				if s.ToolCheck, err = boolParam(c, "tool_check", false); err != nil {
					return nil, err
				}
				stream, err := boolParam(c, "stream", true)
				if err != nil {
					return nil, err
				}
				s.Stream = &stream
				if err := s.Check(); err != nil {
					return nil, err
				}
				b, err := Build(s)
				if err != nil {
					return nil, err
				}
				secret := ""
				if s.As != "" {
					if secret, err = keys.SecretOf(c.R.Context(), s.As); err != nil {
						return nil, err
					}
				}
				base := c.Query("base_url")
				if base == "" {
					base = BaseURL(c.R)
				}
				return MakeSnippets(s, b, base, secret), nil
			},
		},
	}
}

func boolParam(c *api.Call, name string, def bool) (bool, error) {
	s := c.Query(name)
	if s == "" {
		return def, nil
	}
	v, err := strconv.ParseBool(s)
	if err != nil {
		return false, api.BadRequest("Use "+name+"=true or "+name+"=false.", "%s must be true or false, not %q.", name, s)
	}
	return v, nil
}

// BaseURL is the scheme and host a request reached Iroha at.
func BaseURL(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		scheme = "https"
	}
	host := r.Host
	if h := r.Header.Get("X-Forwarded-Host"); h != "" {
		host = h
	}
	return scheme + "://" + host
}

// suggestWindow is how far back suggested counts what a Provider served.
const suggestWindow = 7 * 24 * time.Hour

// suggest is the model of handle (in all) served most, else its first; "" when the caller may use none of it.
func suggest(all []models.CallerModel, handle string, served map[string]int) string {
	best, most := "", 0
	for _, m := range all {
		h, model, ok := strings.Cut(m.ID, "/")
		if !ok || h != handle {
			continue
		}
		if best == "" || served[model] > most {
			best, most = m.ID, served[model]
		}
	}
	return best
}

// ordered is all with the preferred Provider's models (prefer "<handle>/...")
// first, or the preferred Pool first; otherwise all as it is (Pools first).
func ordered(all []models.CallerModel, prefer string) []models.CallerModel {
	if prefer == "" {
		return all
	}
	handle, _, provider := strings.Cut(prefer, "/")
	first := func(m models.CallerModel) bool {
		if provider {
			return strings.HasPrefix(m.ID, handle+"/")
		}
		return m.ID == prefer
	}
	out := make([]models.CallerModel, 0, len(all))
	for _, m := range all {
		if first(m) {
			out = append(out, m)
		}
	}
	for _, m := range all {
		if !first(m) {
			out = append(out, m)
		}
	}
	return out
}

// search filters the caller's models by q, Pools first unless prefer
// names a Provider (see ordered).
func search(all []models.CallerModel, q string, limit int, prefer string) ModelChoices {
	words := strings.Fields(strings.ToLower(q))
	out := ModelChoices{Total: len(all), Pools: []ModelChoice{}, Providers: []ProviderChoice{}}
	n := 0
	for _, m := range ordered(all, prefer) {
		id := strings.ToLower(m.ID)
		match := true
		for _, w := range words {
			if !strings.Contains(id, w) {
				match = false
				break
			}
		}
		if !match {
			continue
		}
		out.Matched++
		handle, model, qualified := strings.Cut(m.ID, "/")
		ch := ModelChoice{ID: m.ID, Model: m.ID, ContextLength: m.ContextLength, Reasoning: m.Reasoning, ReasoningLevels: m.ReasoningLevels}
		if !qualified {
			ch.Maker = m.OwnedBy
			if n < limit {
				out.Pools = append(out.Pools, ch)
				n++
			} else {
				out.Truncated = true
			}
			continue
		}
		ch.Model = model
		if len(out.Providers) == 0 || out.Providers[len(out.Providers)-1].Provider != handle {
			out.Providers = append(out.Providers, ProviderChoice{Provider: handle, Models: []ModelChoice{}})
		}
		p := &out.Providers[len(out.Providers)-1]
		p.Matched++
		if n < limit {
			p.Models = append(p.Models, ch)
			n++
		} else {
			out.Truncated = true
		}
	}
	return out
}
