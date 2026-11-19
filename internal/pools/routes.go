package pools

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/ids"
	"github.com/hoangvu12/iroha/internal/providers"
	"github.com/hoangvu12/iroha/internal/store"
)

// snapshot is what an Audit Entry records of a Pool: all of it, members
// (by Provider ID) included, so a revert restores order and switches.
type snapshot struct {
	ID               string           `json:"id"`
	Name             string           `json:"name"`
	Maker            string           `json:"maker"`
	MaxAttempts      int              `json:"max_attempts"`
	FirstByteSeconds int              `json:"first_byte_seconds"`
	Members          []snapshotMember `json:"members"`
	CreatedAt        time.Time        `json:"created_at"`
}

type snapshotMember struct {
	ProviderID string `json:"provider_id"`
	Model      string `json:"model"`
	Enabled    bool   `json:"enabled"`
}

// Resource is the Model Pool resource of the audit machinery.
var Resource = audit.Register(&audit.Resource[snapshot]{
	Name: "pool", Label: "Model Pool", Plural: "Model Pools", Path: "/api/pools",
	Table:  "pools",
	NameOf: func(s snapshot) string { return s.Name },
	Load: func(ctx context.Context, q audit.Querier, id string) (*snapshot, error) {
		p, err := scanPool(q.QueryRowContext(ctx, `SELECT `+poolColumns+` FROM pools WHERE id = ?`, id))
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		s := &snapshot{ID: p.ID, Name: p.Name, Maker: p.maker, MaxAttempts: p.Budget.MaxAttempts, FirstByteSeconds: p.Budget.FirstByteSeconds,
			Members: []snapshotMember{}, CreatedAt: p.CreatedAt}
		var members string
		if err := q.QueryRowContext(ctx, `SELECT coalesce(json_group_array(json_object('provider_id', provider_id, 'model', model,
				'enabled', json(CASE WHEN enabled THEN 'true' ELSE 'false' END))), '[]')
			FROM (SELECT * FROM pool_members WHERE pool_id = ? ORDER BY position)`, id).Scan(&members); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(members), &s.Members); err != nil {
			return nil, err
		}
		return s, nil
	},
	Restore: func(ctx context.Context, tx *sql.Tx, id string, s *snapshot) error {
		if _, err := tx.ExecContext(ctx, `DELETE FROM pool_members WHERE pool_id = ?`, id); err != nil {
			return err
		}
		if s == nil {
			_, err := tx.ExecContext(ctx, `DELETE FROM pools WHERE id = ?`, id)
			return err
		}
		if err := nameFree(ctx, tx, s.Name, id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO pools (id, name, maker, max_attempts, first_byte_seconds, created_at) VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET name = excluded.name, maker = excluded.maker, max_attempts = excluded.max_attempts, first_byte_seconds = excluded.first_byte_seconds`,
			id, s.Name, s.Maker, s.MaxAttempts, s.FirstByteSeconds, store.Millis(s.CreatedAt)); err != nil {
			return err
		}
		return insertMembers(ctx, tx, id, s.Members)
	},
})

func insertMembers(ctx context.Context, tx *sql.Tx, poolID string, members []snapshotMember) error {
	for i, m := range members {
		if _, err := tx.ExecContext(ctx, `INSERT INTO pool_members (pool_id, position, provider_id, model, enabled) VALUES (?, ?, ?, ?, ?)`,
			poolID, i+1, m.ProviderID, m.Model, m.Enabled); err != nil {
			return err
		}
	}
	return nil
}

// nameFree refuses a name another Pool has, whatever its case.
func nameFree(ctx context.Context, q audit.Querier, name, id string) error {
	var other, otherName string
	err := q.QueryRowContext(ctx, `SELECT id, name FROM pools WHERE name = ? COLLATE NOCASE AND id != ?`, name, id).Scan(&other, &otherName)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	return api.Conflict("name_taken", "Pick another name, or change that Pool instead (PATCH /api/pools/"+otherName+").",
		"Another Model Pool (%s) is already named %q; Pool names may not differ only in case.", otherName, name)
}

// MemberInput is one member in a Pool change.
type MemberInput struct {
	Provider string `json:"provider" doc:"Provider handle or ID."`
	Model    string `json:"model" doc:"The model ID on that Provider, as its own route takes it."`
	Enabled  *bool  `json:"enabled,omitempty" doc:"false switches the member off without removing it. Default true."`
}

// BudgetInput changes a Pool's budget override; omitted fields stay.
type BudgetInput struct {
	MaxAttempts      *int `json:"max_attempts,omitempty" doc:"Attempts per Request across all members, 1 to 10; 0: the first serving Provider's own."`
	FirstByteSeconds *int `json:"first_byte_seconds,omitempty" doc:"Seconds to the first upstream byte across all members, 1 to 95; 0: each serving Provider's own."`
}

// CreatePool is the body of POST /api/pools and each item of its bulk.
type CreatePool struct {
	Name    string         `json:"name" doc:"The model name Callers will send: no slash, 1 to 64 letters, digits, '.', '_' or '-'. Repeating a create with an existing name updates that Pool."`
	Members *[]MemberInput `json:"members,omitempty" doc:"Every member in try order; replaces the list. Omit to keep an existing Pool's members (a new Pool then has none)."`
	Budget  *BudgetInput   `json:"budget,omitempty"`
	Maker   *string        `json:"maker,omitempty" doc:"Who makes the model, for the logo (e.g. anthropic); \"\" to guess it from the model name."`
}

// UpdatePool is the body of PATCH /api/pools/{pool}.
type UpdatePool struct {
	Name    *string        `json:"name,omitempty" doc:"A new name. Gateway Key scopes follow the Pool; Callers must use the new name."`
	Members *[]MemberInput `json:"members,omitempty" doc:"Every member in try order; replaces the list. Reorder or switch members off by sending the list changed."`
	Budget  *BudgetInput   `json:"budget,omitempty"`
	Maker   *string        `json:"maker,omitempty" doc:"Who makes the model, for the logo; \"\" to guess it from the model name."`
}

// PoolResult is the response of a single Pool change.
type PoolResult struct {
	audit.Result
	Pool Pool `json:"pool" doc:"The Pool after the change (on a dry run, as it would be)."`
}

// PoolList is the response of GET /api/pools.
type PoolList struct {
	Pools []Pool `json:"pools"`
}

// MaxMembers is the most members a Pool may have.
const MaxMembers = 32

const membersHint = `Send "members": [{"provider": "<handle>", "model": "<model ID>"}, ...] in the order to try them, at most 32, each Provider and model once.`

var makerPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

// Routes returns the Model Pool routes.
func Routes(tr *audit.Trail, db *store.DB) []api.Route {
	h := handlers{tr: tr, db: db}
	const tag = "Model Pools"
	return []api.Route{
		{
			Method: http.MethodGet, Path: "/api/pools", Tag: tag,
			Summary:  "List Model Pools with their members in try order",
			Response: PoolList{},
			Handle: func(c *api.Call) (any, error) {
				list, err := listPools(c.R.Context(), h.db)
				if err != nil {
					return nil, err
				}
				out := PoolList{Pools: []Pool{}}
				for _, p := range list {
					out.Pools = append(out.Pools, p.Pool)
				}
				return out, nil
			},
		},
		{
			Method: http.MethodGet, Path: "/api/pools/{pool}", Tag: tag,
			Summary:     "Read a Model Pool by name or ID",
			Description: "GET /api/route-preview?model=<pool> shows where a Request for it would go right now.",
			Response:    Pool{},
			Handle: func(c *api.Call) (any, error) {
				id, err := Resource.Resolve(c.R.Context(), h.db, c.Path("pool"))
				if err != nil {
					return nil, err
				}
				p, err := readPool(c.R.Context(), h.db, id)
				return p.Pool, err
			},
		},
		{
			Method: http.MethodPost, Path: "/api/pools", Tag: tag,
			Summary:     "Create a Model Pool, or update the one with that name",
			Description: "Answers 201 with the new Pool. Callers name it as the model on the global routes; Gateway Keys need it in their scope (or scope all).",
			Query:       []api.Param{audit.DryRun},
			Request:     CreatePool{}, Response: PoolResult{},
			Handle: func(c *api.Call) (any, error) {
				var in CreatePool
				if err := c.Decode(&in); err != nil {
					return nil, err
				}
				var out Pool
				res, err := h.tr.Mutate(c, "pool.create", "Created", func(m *audit.Mutation) error {
					var err error
					out, err = h.upsert(m, in)
					return err
				})
				return PoolResult{Result: res, Pool: out}, err
			},
		},
		{
			Method: http.MethodPost, Path: "/api/pools/bulk", Tag: tag,
			Summary:     "Create or update many Model Pools, each by name",
			Description: "Each item is applied or refused on its own; read failed and each item's error.",
			Query:       []api.Param{audit.DryRun},
			Request:     audit.BulkRequest[CreatePool]{}, Response: audit.BulkResult[Pool]{},
			Handle: func(c *api.Call) (any, error) {
				var in audit.BulkRequest[CreatePool]
				if err := c.Decode(&in); err != nil {
					return nil, err
				}
				return audit.Bulk(h.tr, c, "pool.create", "Created", in.Items, h.upsert)
			},
		},
		{
			Method: http.MethodPatch, Path: "/api/pools/{pool}", Tag: tag,
			Summary:     "Rename a Model Pool, replace (reorder, switch on or off) its members, or change its budget or maker",
			Description: "A new member order applies to the next Request.",
			Query:       []api.Param{audit.DryRun},
			Request:     UpdatePool{}, Response: PoolResult{},
			Handle: func(c *api.Call) (any, error) {
				var in UpdatePool
				if err := c.Decode(&in); err != nil {
					return nil, err
				}
				var out Pool
				res, err := h.tr.Mutate(c, "pool.update", "Edited", func(m *audit.Mutation) error {
					id, err := Resource.Resolve(m.Ctx, m.Tx, c.Path("pool"))
					if err != nil {
						return err
					}
					out, err = h.update(m, id, in)
					return err
				})
				return PoolResult{Result: res, Pool: out}, err
			},
		},
		{
			Method: http.MethodDelete, Path: "/api/pools/{pool}", Tag: tag,
			Summary:     "Delete a Model Pool",
			Description: "Refused with 409 pool_in_use while an unrevoked Gateway Key's scope names it. Revertible through its Audit Entry.",
			Query:       []api.Param{audit.DryRun},
			Response:    PoolResult{},
			Handle: func(c *api.Call) (any, error) {
				var out Pool
				res, err := h.tr.Mutate(c, "pool.delete", "Deleted", func(m *audit.Mutation) error {
					id, err := Resource.Resolve(m.Ctx, m.Tx, c.Path("pool"))
					if err != nil {
						return err
					}
					p, err := readPool(m.Ctx, m.Tx, id)
					if err != nil {
						return err
					}
					out = p.Pool
					if err := notInUse(m.Ctx, m.Tx, p); err != nil {
						return err
					}
					if err := m.Track(Resource, id); err != nil {
						return err
					}
					return Resource.Restore(m.Ctx, m.Tx, id, nil)
				})
				return PoolResult{Result: res, Pool: out}, err
			},
		},
	}
}

// notInUse refuses to delete a Pool an unrevoked Gateway Key's scope names.
func notInUse(ctx context.Context, tx *sql.Tx, p row) error {
	rows, err := tx.QueryContext(ctx, `SELECT name FROM gateway_keys WHERE revoked_at IS NULL
		AND EXISTS (SELECT 1 FROM json_each(gateway_keys.scope, '$.pools') WHERE value = ?) ORDER BY name`, p.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return err
		}
		names = append(names, n)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(names) == 0 {
		return nil
	}
	return api.Conflict("pool_in_use", "Remove the Pool from those Gateway Keys' scopes first (PATCH /api/gateway-keys/{key}), then delete it.",
		"Gateway Keys %s may use the Pool %q.", strings.Join(names, ", "), p.Name).WithDetails(map[string]any{"gateway_keys": names})
}

type handlers struct {
	tr *audit.Trail
	db *store.DB
}

func (h handlers) upsert(m *audit.Mutation, in CreatePool) (Pool, error) {
	if err := api.CheckName("name", in.Name); err != nil {
		return Pool{}, err
	}
	var id string
	err := m.Tx.QueryRowContext(m.Ctx, `SELECT id FROM pools WHERE name = ? COLLATE BINARY`, in.Name).Scan(&id)
	if err == nil {
		return h.update(m, id, UpdatePool{Members: in.Members, Budget: in.Budget, Maker: in.Maker})
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Pool{}, err
	}
	if err := nameFree(m.Ctx, m.Tx, in.Name, ""); err != nil {
		return Pool{}, err
	}
	id = ids.New("pl")
	if err := m.Track(Resource, id); err != nil {
		return Pool{}, err
	}
	if _, err := m.Tx.ExecContext(m.Ctx, `INSERT INTO pools (id, name, created_at) VALUES (?, ?, ?)`, id, in.Name, store.Millis(m.Now)); err != nil {
		return Pool{}, err
	}
	return h.apply(m, id, UpdatePool{Members: in.Members, Budget: in.Budget, Maker: in.Maker})
}

func (h handlers) update(m *audit.Mutation, id string, in UpdatePool) (Pool, error) {
	if err := m.Track(Resource, id); err != nil {
		return Pool{}, err
	}
	if in.Name != nil {
		if err := api.CheckName("name", *in.Name); err != nil {
			return Pool{}, err
		}
		if err := nameFree(m.Ctx, m.Tx, *in.Name, id); err != nil {
			return Pool{}, err
		}
		if _, err := m.Tx.ExecContext(m.Ctx, `UPDATE pools SET name = ? WHERE id = ?`, *in.Name, id); err != nil {
			return Pool{}, err
		}
	}
	return h.apply(m, id, in)
}

// apply writes the members, budget and maker of in (each when sent).
func (h handlers) apply(m *audit.Mutation, id string, in UpdatePool) (Pool, error) {
	if in.Members != nil {
		members, err := checkMembers(m.Ctx, m.Tx, *in.Members)
		if err != nil {
			return Pool{}, err
		}
		if _, err := m.Tx.ExecContext(m.Ctx, `DELETE FROM pool_members WHERE pool_id = ?`, id); err != nil {
			return Pool{}, err
		}
		if err := insertMembers(m.Ctx, m.Tx, id, members); err != nil {
			return Pool{}, err
		}
	}
	if b := in.Budget; b != nil {
		if err := (providers.BudgetOverrides{MaxAttempts: b.MaxAttempts, FirstByteSeconds: b.FirstByteSeconds}).Check(); err != nil {
			return Pool{}, err
		}
		if b.MaxAttempts != nil {
			if _, err := m.Tx.ExecContext(m.Ctx, `UPDATE pools SET max_attempts = ? WHERE id = ?`, *b.MaxAttempts, id); err != nil {
				return Pool{}, err
			}
		}
		if b.FirstByteSeconds != nil {
			if _, err := m.Tx.ExecContext(m.Ctx, `UPDATE pools SET first_byte_seconds = ? WHERE id = ?`, *b.FirstByteSeconds, id); err != nil {
				return Pool{}, err
			}
		}
	}
	if in.Maker != nil {
		mk := strings.TrimSpace(*in.Maker)
		if mk != "" && !makerPattern.MatchString(mk) {
			return Pool{}, api.BadRequest("Use a lowercase maker ID such as anthropic, openai or zhipuai (letters, digits, '.', '_', '-'), or \"\" to guess it.", "maker %q is not valid.", mk)
		}
		if _, err := m.Tx.ExecContext(m.Ctx, `UPDATE pools SET maker = ? WHERE id = ?`, mk, id); err != nil {
			return Pool{}, err
		}
	}
	p, err := readPool(m.Ctx, m.Tx, id)
	return p.Pool, err
}

// checkMembers validates members and resolves their Providers.
func checkMembers(ctx context.Context, tx *sql.Tx, in []MemberInput) ([]snapshotMember, error) {
	if len(in) > MaxMembers {
		return nil, api.BadRequest(membersHint, "A Pool has at most %d members; %d were sent.", MaxMembers, len(in))
	}
	out := make([]snapshotMember, 0, len(in))
	seen := map[string]int{}
	for i, m := range in {
		if strings.TrimSpace(m.Provider) == "" {
			return nil, api.BadRequest(membersHint, "Member %d names no provider.", i+1)
		}
		pid, err := providers.ResolveID(ctx, tx, m.Provider)
		if err != nil {
			return nil, err
		}
		model := strings.TrimSpace(m.Model)
		switch {
		case model == "":
			return nil, api.BadRequest(membersHint, "Member %d (%s) names no model.", i+1, m.Provider)
		case len(model) > 256:
			return nil, api.BadRequest(membersHint, "Member %d's model is longer than 256 characters.", i+1)
		}
		key := pid + "\x00" + model
		if j, ok := seen[key]; ok {
			return nil, api.BadRequest(membersHint, "Members %d and %d are both %s/%s.", j+1, i+1, m.Provider, model)
		}
		seen[key] = i
		out = append(out, snapshotMember{ProviderID: pid, Model: model, Enabled: m.Enabled == nil || *m.Enabled})
	}
	return out, nil
}
