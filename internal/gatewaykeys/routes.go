package gatewaykeys

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/ids"
	"github.com/hoangvu12/iroha/internal/store"
)

// snapshot is what an Audit Entry records of a Gateway Key: configuration,
// not last_used_at.
type snapshot struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Secret    string     `json:"secret"`
	Scope     stored     `json:"scope"`
	Capture   bool       `json:"capture"`
	CreatedAt time.Time  `json:"created_at"`
	RevokedAt *time.Time `json:"revoked_at"`
}

// Resource is the Gateway Key resource of the audit machinery.
var Resource = audit.Register(&audit.Resource[snapshot]{
	Name: "gateway_key", Label: "Gateway Key", Plural: "Gateway Keys", Path: "/api/gateway-keys",
	Table: "gateway_keys", Secrets: []string{"secret"},
	NameOf: func(s snapshot) string { return s.Name },
	Load: func(ctx context.Context, q audit.Querier, id string) (*snapshot, error) {
		k, err := scan(q.QueryRowContext(ctx, `SELECT `+keyColumns+` FROM gateway_keys WHERE id = ?`, id))
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		return &snapshot{ID: k.ID, Name: k.Name, Secret: k.Secret, Scope: k.scope, Capture: k.Capture, CreatedAt: k.CreatedAt, RevokedAt: k.RevokedAt}, nil
	},
	Restore: func(ctx context.Context, tx *sql.Tx, id string, s *snapshot) error {
		if s == nil {
			_, err := tx.ExecContext(ctx, `DELETE FROM gateway_keys WHERE id = ?`, id)
			return err
		}
		if err := nameFree(ctx, tx, s.Name, id); err != nil {
			return err
		}
		var revoked any
		if s.RevokedAt != nil {
			revoked = store.Millis(*s.RevokedAt)
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO gateway_keys (id, name, secret, scope, capture, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET name = excluded.name, secret = excluded.secret, scope = excluded.scope, capture = excluded.capture, revoked_at = excluded.revoked_at`,
			id, s.Name, s.Secret, s.Scope.json(), s.Capture, store.Millis(s.CreatedAt), revoked)
		return err
	},
})

func nameFree(ctx context.Context, q audit.Querier, name, id string) error {
	var other string
	err := q.QueryRowContext(ctx, `SELECT id FROM gateway_keys WHERE name = ? AND id != ?`, name, id).Scan(&other)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	return api.Conflict("name_taken", "Pick another name, or rename that Gateway Key first (PATCH /api/gateway-keys/"+name+").",
		"Another Gateway Key (%s) is already named %q.", other, name)
}

// CreateGatewayKey is the body of POST /api/gateway-keys and each item of its bulk.
type CreateGatewayKey struct {
	Name    string `json:"name" doc:"Unique name, usually the Caller it is issued to. Repeating a create with an existing name updates that key."`
	Scope   *Scope `json:"scope,omitempty" doc:"What the key may use. Required for a new key; omit to keep the scope of an existing one."`
	Capture *bool  `json:"capture,omitempty" doc:"Store the full prompt and response of this key's Requests. Default false for a new key; omit to keep the current setting."`
}

// UpdateGatewayKey is the body of PATCH /api/gateway-keys/{key}.
type UpdateGatewayKey struct {
	Name    *string `json:"name,omitempty"`
	Scope   *Scope  `json:"scope,omitempty" doc:"Replaces the whole scope."`
	Capture *bool   `json:"capture,omitempty" doc:"true: store the full prompt and response of this key's later Requests; false: stop storing them (captures already stored stay until they expire)."`
}

// BulkUpdateGatewayKey is one item of POST /api/gateway-keys/bulk/update.
type BulkUpdateGatewayKey struct {
	Key     string `json:"key" doc:"The key to change, by name or ID."`
	Scope   *Scope `json:"scope,omitempty" doc:"Replaces the whole scope; omit to keep it."`
	Capture *bool  `json:"capture,omitempty" doc:"Store the full prompt and response of this key's later Requests (true) or stop (false); omit to keep it."`
}

// GatewayKeyResult is the response of a single Gateway Key change.
type GatewayKeyResult struct {
	audit.Result
	GatewayKey GatewayKey `json:"gateway_key" doc:"The key after the change (on a dry run, as it would be; a new key's ID and secret are then placeholders)."`
}

// GatewayKeyList is the response of GET /api/gateway-keys.
type GatewayKeyList struct {
	GatewayKeys []GatewayKey `json:"gateway_keys"`
}

const revokedForever = "Revoked Gateway Keys never work again; issue a new key instead."

// Routes returns the Gateway Key routes.
func Routes(tr *audit.Trail, db *store.DB) []api.Route {
	h := handlers{tr: tr, db: db}
	const tag = "Gateway Keys"
	return []api.Route{
		{
			Method: http.MethodGet, Path: "/api/gateway-keys", Tag: tag,
			Summary: "List Gateway Keys with their secrets and scopes",
			Query: []api.Param{
				{Name: "revoked", Type: "boolean", Description: "true: only revoked keys; false: only active ones. Default: all."},
			},
			Response: GatewayKeyList{},
			Handle:   h.list,
		},
		{
			Method: http.MethodGet, Path: "/api/gateway-keys/{key}", Tag: tag,
			Summary:  "Read a Gateway GatewayKey, secret included, by name or ID",
			Response: GatewayKey{},
			Handle: func(c *api.Call) (any, error) {
				id, err := Resource.Resolve(c.R.Context(), h.db, c.Path("key"))
				if err != nil {
					return nil, err
				}
				return byID(c.R.Context(), h.db, id, h.db.Clock().Now())
			},
		},
		{
			Method: http.MethodPost, Path: "/api/gateway-keys", Tag: tag,
			Summary:     "Issue a Gateway GatewayKey, or update the one with that name",
			Description: "Answers 201 with the new key (secret included). A revoked name cannot be reused.",
			Query:       []api.Param{audit.DryRun},
			Request:     CreateGatewayKey{}, Response: GatewayKeyResult{},
			Handle: func(c *api.Call) (any, error) {
				var in CreateGatewayKey
				if err := c.Decode(&in); err != nil {
					return nil, err
				}
				var out GatewayKey
				res, err := h.tr.Mutate(c, "gateway_key.create", "Issued", func(m *audit.Mutation) error {
					var err error
					out, err = h.upsert(m, in)
					return err
				})
				return GatewayKeyResult{Result: res, GatewayKey: out}, err
			},
		},
		{
			Method: http.MethodPost, Path: "/api/gateway-keys/bulk", Tag: tag,
			Summary:     "Issue or update many Gateway Keys, each by name",
			Description: "Each item is applied or refused on its own; read failed and each item's error.",
			Query:       []api.Param{audit.DryRun},
			Request:     audit.BulkRequest[CreateGatewayKey]{}, Response: audit.BulkResult[GatewayKey]{},
			Handle: func(c *api.Call) (any, error) {
				var in audit.BulkRequest[CreateGatewayKey]
				if err := c.Decode(&in); err != nil {
					return nil, err
				}
				return audit.Bulk(h.tr, c, "gateway_key.create", "Issued", in.Items, h.upsert)
			},
		},
		{
			Method: http.MethodPatch, Path: "/api/gateway-keys/{key}", Tag: tag,
			Summary: "Rename a Gateway Key, replace its scope, or turn prompt capture on or off",
			Query:   []api.Param{audit.DryRun},
			Request: UpdateGatewayKey{}, Response: GatewayKeyResult{},
			Handle: func(c *api.Call) (any, error) {
				var in UpdateGatewayKey
				if err := c.Decode(&in); err != nil {
					return nil, err
				}
				var out GatewayKey
				res, err := h.tr.Mutate(c, "gateway_key.update", "Edited", func(m *audit.Mutation) error {
					id, err := Resource.Resolve(m.Ctx, m.Tx, c.Path("key"))
					if err != nil {
						return err
					}
					out, err = h.update(m, id, in)
					return err
				})
				return GatewayKeyResult{Result: res, GatewayKey: out}, err
			},
		},
		{
			Method: http.MethodPost, Path: "/api/gateway-keys/{key}/revoke", Tag: tag,
			Summary:     "Revoke a Gateway GatewayKey, by name or ID",
			Description: "Permanent: the Audit Entry cannot be reverted. Requests already admitted finish. Revoking a revoked key changes nothing.",
			Query:       []api.Param{audit.DryRun},
			Response:    GatewayKeyResult{},
			Handle: func(c *api.Call) (any, error) {
				var out GatewayKey
				res, err := h.tr.Mutate(c, "gateway_key.revoke", "Revoked", func(m *audit.Mutation) error {
					var err error
					out, err = h.revoke(m, c.Path("key"))
					return err
				})
				return GatewayKeyResult{Result: res, GatewayKey: out}, err
			},
		},
		{
			Method: http.MethodDelete, Path: "/api/gateway-keys/{key}", Tag: tag,
			Summary: "Delete a Gateway Key, by name or ID",
			Description: "Removes the key and frees its name; Callers still holding it get 401 gateway_key_invalid. Requests already recorded keep the key's name. " +
				"Revertible through the Audit Entry (the same secret works again). Revoke instead to keep the key on record.",
			Query:    []api.Param{audit.DryRun},
			Response: GatewayKeyResult{},
			Handle: func(c *api.Call) (any, error) {
				var out GatewayKey
				res, err := h.tr.Mutate(c, "gateway_key.delete", "Deleted", func(m *audit.Mutation) error {
					id, err := Resource.Resolve(m.Ctx, m.Tx, c.Path("key"))
					if err != nil {
						return err
					}
					if out, err = byID(m.Ctx, m.Tx, id, m.Now); err != nil {
						return err
					}
					if err := m.Track(Resource, id); err != nil {
						return err
					}
					_, err = m.Tx.ExecContext(m.Ctx, `DELETE FROM gateway_keys WHERE id = ?`, id)
					return err
				})
				return GatewayKeyResult{Result: res, GatewayKey: out}, err
			},
		},
		{
			Method: http.MethodPost, Path: "/api/gateway-keys/bulk/update", Tag: tag,
			Summary: "Change the scope or prompt capture of many Gateway Keys in one change",
			Description: `Body {"items": [{"key": "discord-bot", "capture": true}, {"key": "gk_...", "capture": true}]}. ` +
				"Each item names one key (name or ID) and only the fields to change; fields left out stay as that key has them. " +
				"Names are changed one key at a time (PATCH). Each item is applied or refused on its own; one Audit Entry covers them all, so one revert undoes it.",
			Query:   []api.Param{audit.DryRun},
			Request: audit.BulkRequest[BulkUpdateGatewayKey]{}, Response: audit.BulkResult[GatewayKey]{},
			Handle: func(c *api.Call) (any, error) {
				var in audit.BulkRequest[BulkUpdateGatewayKey]
				if err := c.Decode(&in); err != nil {
					return nil, err
				}
				return audit.Bulk(h.tr, c, "gateway_key.update", "Edited", in.Items, func(m *audit.Mutation, it BulkUpdateGatewayKey) (GatewayKey, error) {
					if strings.TrimSpace(it.Key) == "" {
						return GatewayKey{}, api.BadRequest(`Name the key in each item: {"key": "discord-bot", ...}.`, "An item has no key.")
					}
					id, err := Resource.Resolve(m.Ctx, m.Tx, it.Key)
					if err != nil {
						return GatewayKey{}, err
					}
					return h.update(m, id, UpdateGatewayKey{Scope: it.Scope, Capture: it.Capture})
				})
			},
		},
		{
			Method: http.MethodPost, Path: "/api/gateway-keys/bulk/revoke", Tag: tag,
			Summary:     "Revoke many Gateway Keys, each by name or ID",
			Description: `Body {"items": ["discord-bot", "gk_..."]}. Each item is applied or refused on its own.`,
			Query:       []api.Param{audit.DryRun},
			Request:     audit.BulkRequest[string]{}, Response: audit.BulkResult[GatewayKey]{},
			Handle: func(c *api.Call) (any, error) {
				var in audit.BulkRequest[string]
				if err := c.Decode(&in); err != nil {
					return nil, err
				}
				return audit.Bulk(h.tr, c, "gateway_key.revoke", "Revoked", in.Items, h.revoke)
			},
		},
	}
}

type handlers struct {
	tr *audit.Trail
	db *store.DB
}

func (h handlers) list(c *api.Call) (any, error) {
	q := `SELECT id FROM gateway_keys`
	switch c.Query("revoked") {
	case "":
	case "true":
		q += ` WHERE revoked_at IS NOT NULL`
	case "false":
		q += ` WHERE revoked_at IS NULL`
	default:
		return nil, api.BadRequest("Use revoked=true, revoked=false, or leave it out for all keys.", "revoked must be true or false.")
	}
	rows, err := h.db.QueryContext(c.R.Context(), q+` ORDER BY created_at, rowid`)
	if err != nil {
		return nil, err
	}
	var idList []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		idList = append(idList, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := GatewayKeyList{GatewayKeys: []GatewayKey{}}
	now := h.db.Clock().Now()
	for _, id := range idList {
		k, err := byID(c.R.Context(), h.db, id, now)
		if err != nil {
			return nil, err
		}
		out.GatewayKeys = append(out.GatewayKeys, k)
	}
	return out, nil
}

func (h handlers) upsert(m *audit.Mutation, in CreateGatewayKey) (GatewayKey, error) {
	if err := api.CheckName("name", in.Name); err != nil {
		return GatewayKey{}, err
	}
	var id string
	err := m.Tx.QueryRowContext(m.Ctx, `SELECT id FROM gateway_keys WHERE name = ?`, in.Name).Scan(&id)
	if err == nil {
		k, err := byID(m.Ctx, m.Tx, id, m.Now)
		if err != nil {
			return k, err
		}
		if k.Revoked {
			return k, api.Conflict("gateway_key_revoked", "Pick another name for the new key; revoked keys and their names stay as a record.",
				"The Gateway Key %q was revoked; it cannot be issued again.", in.Name)
		}
		return h.update(m, id, UpdateGatewayKey{Scope: in.Scope, Capture: in.Capture})
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return GatewayKey{}, err
	}
	if in.Scope == nil {
		return GatewayKey{}, api.BadRequest(scopeHint, "scope is required for a new Gateway Key.")
	}
	scope, err := normalize(m.Ctx, m.Tx, *in.Scope)
	if err != nil {
		return GatewayKey{}, err
	}
	id = ids.New("gk")
	if err := m.Track(Resource, id); err != nil {
		return GatewayKey{}, err
	}
	capture := in.Capture != nil && *in.Capture
	if _, err := m.Tx.ExecContext(m.Ctx, `INSERT INTO gateway_keys (id, name, secret, scope, capture, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		id, in.Name, ids.Secret(SecretPrefix), scope.json(), capture, store.Millis(m.Now)); err != nil {
		return GatewayKey{}, err
	}
	return byID(m.Ctx, m.Tx, id, m.Now)
}

func (h handlers) update(m *audit.Mutation, id string, in UpdateGatewayKey) (GatewayKey, error) {
	if err := m.Track(Resource, id); err != nil {
		return GatewayKey{}, err
	}
	cur, err := byID(m.Ctx, m.Tx, id, m.Now)
	if err != nil {
		return cur, err
	}
	if cur.Revoked && (in.Name != nil || in.Scope != nil || in.Capture != nil) {
		return cur, api.Conflict("gateway_key_revoked", revokedForever, "The Gateway Key %q is revoked and cannot be edited.", cur.Name)
	}
	if in.Name != nil {
		if err := api.CheckName("name", *in.Name); err != nil {
			return cur, err
		}
		if err := nameFree(m.Ctx, m.Tx, *in.Name, id); err != nil {
			return cur, err
		}
		if _, err := m.Tx.ExecContext(m.Ctx, `UPDATE gateway_keys SET name = ? WHERE id = ?`, *in.Name, id); err != nil {
			return cur, err
		}
	}
	if in.Scope != nil {
		scope, err := normalize(m.Ctx, m.Tx, *in.Scope)
		if err != nil {
			return cur, err
		}
		if _, err := m.Tx.ExecContext(m.Ctx, `UPDATE gateway_keys SET scope = ? WHERE id = ?`, scope.json(), id); err != nil {
			return cur, err
		}
	}
	if in.Capture != nil {
		if _, err := m.Tx.ExecContext(m.Ctx, `UPDATE gateway_keys SET capture = ? WHERE id = ?`, *in.Capture, id); err != nil {
			return cur, err
		}
	}
	return byID(m.Ctx, m.Tx, id, m.Now)
}

func (h handlers) revoke(m *audit.Mutation, ref string) (GatewayKey, error) {
	id, err := Resource.Resolve(m.Ctx, m.Tx, ref)
	if err != nil {
		return GatewayKey{}, err
	}
	k, err := byID(m.Ctx, m.Tx, id, m.Now)
	if err != nil || k.Revoked {
		return k, err
	}
	if err := m.Track(Resource, id); err != nil {
		return k, err
	}
	m.Irreversible(revokedForever)
	if _, err := m.Tx.ExecContext(m.Ctx, `UPDATE gateway_keys SET revoked_at = ? WHERE id = ?`, store.Millis(m.Now), id); err != nil {
		return k, err
	}
	return byID(m.Ctx, m.Tx, id, m.Now)
}
