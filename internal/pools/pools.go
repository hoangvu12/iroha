// Package pools stores Model Pools: a model name Callers ask for on the
// global routes, served in order by members, each a model on one Provider.
// It serves /api/pools and gives the Gateway the Pool a Caller named
// (Store.Lookup). Planning a Pool is the planner's job; this package only
// says which members, in which order, are switched on.
package pools

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/store"
)

// Pool is a Model Pool as the API returns it.
type Pool struct {
	ID           string    `json:"id"`
	Name         string    `json:"name" doc:"The model name Callers send to the global routes (no slash). Unique across Pools, whatever the case; stays the same while members change."`
	Maker        string    `json:"maker" doc:"Who makes the Pool's model (e.g. anthropic, openai, zhipuai), for its logo. The Owner's choice, else guessed from the model name; \"\" when no guess fits."`
	MakerGuessed bool      `json:"maker_guessed" doc:"true when maker is a guess (the Owner set none)."`
	Members      []Member  `json:"members" doc:"In try order: a Request is served by the first switched-on member with a usable key, then the next, within the Request's budget."`
	Budget       Budget    `json:"budget"`
	CreatedAt    time.Time `json:"created_at"`
}

// Member is one member of a Pool.
type Member struct {
	Position int    `json:"position" doc:"1 for the member tried first."`
	Provider string `json:"provider" doc:"Provider handle."`
	Model    string `json:"model" doc:"The model ID on that Provider, exactly as its own route takes it (Endpoint renames still apply)."`
	Enabled  bool   `json:"enabled" doc:"false: switched off; kept in the Pool and reported by the route preview, never tried."`
}

// Budget is a Pool's override of the Request budget; 0 keeps the default.
type Budget struct {
	MaxAttempts      int `json:"max_attempts" doc:"Attempts per Request across all members, 1 to 10; 0: the first serving Provider's own (default 3)."`
	FirstByteSeconds int `json:"first_byte_seconds" doc:"Seconds a Request waits for the first upstream byte across all members, 1 to 95; 0: each serving Provider's own (default 60)."`
}

// Routing is what the Gateway needs of a Pool to serve it.
type Routing struct {
	ID, Name    string
	MaxAttempts int           // 0: no override
	FirstByte   time.Duration // 0: no override
	Maker       string        // as the API shows it (the Owner's or the guess)
	CreatedAt   time.Time
	Members     []RoutingMember
}

// RoutingMember is one member of a Pool, switched on or off.
type RoutingMember struct {
	Position   int
	ProviderID string
	Handle     string
	Model      string
	Enabled    bool
}

type queryer interface {
	audit.Querier
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

// Store gives the Gateway and the model list what they need of Pools.
type Store struct{ db *store.DB }

// New returns a Store.
func New(db *store.DB) *Store { return &Store{db: db} }

// Lookup returns the Pool named exactly name; ok is false when there is none.
func (s *Store) Lookup(ctx context.Context, name string) (Routing, bool, error) {
	if name == "" || strings.Contains(name, "/") {
		return Routing{}, false, nil
	}
	var id string
	err := s.db.QueryRowContext(ctx, `SELECT id FROM pools WHERE name = ? COLLATE BINARY`, name).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return Routing{}, false, nil
	}
	if err != nil {
		return Routing{}, false, err
	}
	p, err := readPool(ctx, s.db, id)
	if err != nil {
		return Routing{}, false, err
	}
	return p.routing(), true, nil
}

// All returns every Pool, by name.
func (s *Store) All(ctx context.Context) ([]Routing, error) {
	list, err := listPools(ctx, s.db)
	if err != nil {
		return nil, err
	}
	out := make([]Routing, 0, len(list))
	for _, p := range list {
		out = append(out, p.routing())
	}
	return out, nil
}

// row is a Pool as read, with its members' Provider IDs.
type row struct {
	Pool
	maker       string // the Owner's
	providerIDs []string
}

func (p row) routing() Routing {
	r := Routing{ID: p.ID, Name: p.Name, MaxAttempts: p.Budget.MaxAttempts, FirstByte: time.Duration(p.Budget.FirstByteSeconds) * time.Second,
		Maker: p.Maker, CreatedAt: p.CreatedAt}
	for i, m := range p.Members {
		r.Members = append(r.Members, RoutingMember{Position: m.Position, ProviderID: p.providerIDs[i], Handle: m.Provider, Model: m.Model, Enabled: m.Enabled})
	}
	return r
}

const poolColumns = `id, name, maker, max_attempts, first_byte_seconds, created_at`

func scanPool(r interface{ Scan(...any) error }) (row, error) {
	var p row
	var created int64
	if err := r.Scan(&p.ID, &p.Name, &p.maker, &p.Budget.MaxAttempts, &p.Budget.FirstByteSeconds, &created); err != nil {
		return p, err
	}
	p.CreatedAt = store.FromMillis(created)
	return p, nil
}

// readPool reads one Pool with its members; sql.ErrNoRows when absent.
func readPool(ctx context.Context, q queryer, id string) (row, error) {
	p, err := scanPool(q.QueryRowContext(ctx, `SELECT `+poolColumns+` FROM pools WHERE id = ?`, id))
	if err != nil {
		return p, err
	}
	return withMembers(ctx, q, p)
}

func listPools(ctx context.Context, q queryer) ([]row, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+poolColumns+` FROM pools ORDER BY name, id`)
	if err != nil {
		return nil, err
	}
	var list []row
	for rows.Next() {
		p, err := scanPool(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		list = append(list, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range list {
		if list[i], err = withMembers(ctx, q, list[i]); err != nil {
			return nil, err
		}
	}
	return list, nil
}

func withMembers(ctx context.Context, q queryer, p row) (row, error) {
	rows, err := q.QueryContext(ctx, `SELECT m.position, m.provider_id, coalesce(pr.handle, m.provider_id), m.model, m.enabled
		FROM pool_members m LEFT JOIN providers pr ON pr.id = m.provider_id WHERE m.pool_id = ? ORDER BY m.position`, p.ID)
	if err != nil {
		return p, err
	}
	defer rows.Close()
	p.Members = []Member{}
	for rows.Next() {
		var m Member
		var pid string
		if err := rows.Scan(&m.Position, &pid, &m.Provider, &m.Model, &m.Enabled); err != nil {
			return p, err
		}
		p.Members = append(p.Members, m)
		p.providerIDs = append(p.providerIDs, pid)
	}
	if err := rows.Err(); err != nil {
		return p, err
	}
	p.Maker, p.MakerGuessed = p.maker, false
	if p.maker == "" {
		p.Maker = GuessMaker(p.Name)
		for i := 0; p.Maker == "" && i < len(p.Members); i++ {
			p.Maker = GuessMaker(p.Members[i].Model)
		}
		p.MakerGuessed = p.Maker != ""
	}
	return p, nil
}

// ResolveID returns the ID of the Pool addressed by name or ID, with the
// uniform 404 when there is none.
func ResolveID(ctx context.Context, q audit.Querier, ref string) (string, error) {
	return Resource.Resolve(ctx, q, ref)
}

// Names maps Pool IDs to names (IDs without a Pool are left out).
func Names(ctx context.Context, q audit.Querier, ids []string) (map[string]string, error) {
	out := map[string]string{}
	for _, id := range ids {
		var n string
		err := q.QueryRowContext(ctx, `SELECT name FROM pools WHERE id = ?`, id).Scan(&n)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, err
		}
		out[id] = n
	}
	return out, nil
}

// makers maps the start of a model name to its maker, for Pool logos.
var makers = []struct{ prefix, maker string }{
	{"claude", "anthropic"},
	{"gpt", "openai"}, {"chatgpt", "openai"}, {"o1", "openai"}, {"o3", "openai"}, {"o4", "openai"}, {"codex", "openai"},
	{"gemini", "google"}, {"gemma", "google"},
	{"llama", "meta"},
	{"qwen", "alibaba"}, {"qwq", "alibaba"},
	{"deepseek", "deepseek"},
	{"glm", "zhipuai"}, {"chatglm", "zhipuai"},
	{"kimi", "moonshotai"}, {"moonshot", "moonshotai"},
	{"mistral", "mistral"}, {"mixtral", "mistral"}, {"codestral", "mistral"}, {"devstral", "mistral"}, {"magistral", "mistral"}, {"ministral", "mistral"}, {"pixtral", "mistral"},
	{"grok", "xai"},
	{"minimax", "minimax"}, {"abab", "minimax"},
	{"command", "cohere"},
	{"ernie", "baidu"},
	{"hunyuan", "tencent"},
	{"doubao", "bytedance"}, {"seed", "bytedance"},
	{"phi", "microsoft"},
	{"nemotron", "nvidia"},
	{"step", "stepfun"},
	{"yi", "01-ai"},
}

// GuessMaker guesses who makes a model from its name ("z-ai/glm-4.6" ->
// zhipuai); "" when no known name fits. Only the part after the last slash
// counts, and a known name must be followed by the end or a non-letter, so
// "phind" is not Microsoft's.
func GuessMaker(model string) string {
	m := strings.ToLower(model)
	if i := strings.LastIndex(m, "/"); i >= 0 {
		m = m[i+1:]
	}
	for _, k := range makers {
		if !strings.HasPrefix(m, k.prefix) {
			continue
		}
		rest := m[len(k.prefix):]
		if rest == "" || !(rest[0] >= 'a' && rest[0] <= 'z') {
			return k.maker
		}
	}
	return ""
}
