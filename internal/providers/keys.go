package providers

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/ids"
	"github.com/hoangvu12/iroha/internal/store"
)

// keySnapshot is what an Audit Entry records of an Upstream Key: its
// configuration, not last_used_at (nor, from ticket 05, its Key State).
type keySnapshot struct {
	ID         string    `json:"id"`
	ProviderID string    `json:"provider_id"`
	Provider   string    `json:"provider"`
	Name       string    `json:"name"`
	Secret     string    `json:"secret"`
	CreatedAt  time.Time `json:"created_at"`
}

// KeyResource is the Upstream Key resource of the audit machinery.
var KeyResource = audit.Register(&audit.Resource[keySnapshot]{
	Name: "upstream_key", Label: "Upstream Key", Plural: "Upstream Keys", Path: "/api/providers/{provider}/keys",
	Table: "upstream_keys", Secrets: []string{"secret"},
	NameOf: func(s keySnapshot) string { return s.Provider + "/" + s.Name },
	Load: func(ctx context.Context, q audit.Querier, id string) (*keySnapshot, error) {
		var s keySnapshot
		var created int64
		err := q.QueryRowContext(ctx, `SELECT k.id, k.provider_id, p.handle, k.name, k.secret, k.created_at
			FROM upstream_keys k JOIN providers p ON p.id = k.provider_id WHERE k.id = ?`, id).
			Scan(&s.ID, &s.ProviderID, &s.Provider, &s.Name, &s.Secret, &created)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		s.CreatedAt = store.FromMillis(created)
		return &s, err
	},
	Restore: func(ctx context.Context, tx *sql.Tx, id string, s *keySnapshot) error {
		if s == nil {
			_, err := tx.ExecContext(ctx, `DELETE FROM upstream_keys WHERE id = ?`, id)
			return err
		}
		if err := childNameFree(ctx, tx, "upstream_keys", "Upstream Key", s.ProviderID, s.Name, id); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO upstream_keys (id, provider_id, name, secret, created_at) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET name = excluded.name, secret = excluded.secret`,
			id, s.ProviderID, s.Name, s.Secret, store.Millis(s.CreatedAt))
		return err
	},
})

// CreateUpstreamKey is the body of POST /api/providers/{provider}/keys and
// each item of its bulk.
type CreateUpstreamKey struct {
	Name   string  `json:"name,omitempty" doc:"Unique within the Provider. Omit it to match by secret: a secret the Provider already holds answers that key unchanged, a new one gets the next free name key-N. Repeating a create with an existing name updates that key."`
	Secret *string `json:"secret,omitempty" doc:"The key issued by the Provider. Omit (with a name) for a keyless slot that sends no auth header. Surrounding whitespace is trimmed."`
}

// UpdateUpstreamKey is the body of PATCH /api/providers/{provider}/keys/{key}.
type UpdateUpstreamKey struct {
	Name   *string `json:"name,omitempty"`
	Secret *string `json:"secret,omitempty" doc:"Replace the secret; empty makes the key keyless."`
}

// UpstreamKeyResult is the response of a single Upstream Key change.
type UpstreamKeyResult struct {
	audit.Result
	UpstreamKey UpstreamKey `json:"upstream_key" doc:"The key after the change (before it, for a delete)."`
}

// UpstreamKeyList is the response of GET /api/providers/{provider}/keys.
type UpstreamKeyList struct {
	UpstreamKeys []UpstreamKey `json:"upstream_keys"`
}

const secretHint = "Paste the key exactly as the Provider issued it; it cannot contain spaces or line breaks."

// cleanSecret trims and validates a secret.
func cleanSecret(s string) (string, error) {
	s = strings.TrimSpace(s)
	if len(s) > 4096 {
		return "", api.BadRequest(secretHint, "secret is longer than 4096 characters.")
	}
	for _, c := range s {
		if unicode.IsSpace(c) || unicode.IsControl(c) {
			return "", api.BadRequest(secretHint+" Send several keys as separate items of POST .../keys/bulk.", "secret contains whitespace or a control character.")
		}
	}
	return s, nil
}

func (h handlers) keyRoutes() []api.Route {
	const tag = "Upstream Keys"
	const base = "/api/providers/{provider}/keys"
	return []api.Route{
		{
			Method: http.MethodGet, Path: base, Tag: tag,
			Summary:  "List a Provider's Upstream Keys, secrets included",
			Response: UpstreamKeyList{},
			Handle: func(c *api.Call) (any, error) {
				p, err := resolveProvider(c.R.Context(), h.db, c.Path("provider"))
				if err != nil {
					return nil, err
				}
				rows, err := h.db.QueryContext(c.R.Context(), `SELECT `+keyColumns+` FROM upstream_keys k JOIN providers p ON p.id = k.provider_id
					WHERE k.provider_id = ? ORDER BY k.created_at, k.rowid`, p.id)
				if err != nil {
					return nil, err
				}
				defer rows.Close()
				out := UpstreamKeyList{UpstreamKeys: []UpstreamKey{}}
				for rows.Next() {
					k, err := scanKey(rows)
					if err != nil {
						return nil, err
					}
					out.UpstreamKeys = append(out.UpstreamKeys, k)
				}
				return out, rows.Err()
			},
		},
		{
			Method: http.MethodGet, Path: base + "/{key}", Tag: tag,
			Summary:  "Read an Upstream Key, secret included, by name or ID",
			Response: UpstreamKey{},
			Handle: func(c *api.Call) (any, error) {
				p, err := resolveProvider(c.R.Context(), h.db, c.Path("provider"))
				if err != nil {
					return nil, err
				}
				id, err := resolveChild(c.R.Context(), h.db, "upstream_keys", "Upstream Key", "keys", p, c.Path("key"))
				if err != nil {
					return nil, err
				}
				return readKey(c.R.Context(), h.db, id)
			},
		},
		{
			Method: http.MethodPost, Path: base, Tag: tag,
			Summary:     "Add an Upstream Key, or update the one with that name",
			Description: "Without a name the key is matched by its secret, so pasting the same key twice never makes a duplicate.",
			Query:       []api.Param{audit.DryRun},
			Request:     CreateUpstreamKey{}, Response: UpstreamKeyResult{},
			Handle: func(c *api.Call) (any, error) {
				var in CreateUpstreamKey
				if err := c.Decode(&in); err != nil {
					return nil, err
				}
				var out UpstreamKey
				res, err := h.tr.Mutate(c, "upstream_key.create", "Added", func(m *audit.Mutation) error {
					p, err := resolveProvider(m.Ctx, m.Tx, c.Path("provider"))
					if err != nil {
						return err
					}
					out, err = h.upsertKey(m, p, in)
					return err
				})
				return UpstreamKeyResult{Result: res, UpstreamKey: out}, err
			},
		},
		{
			Method: http.MethodPost, Path: base + "/bulk", Tag: tag,
			Summary:     "Add or update many Upstream Keys of a Provider",
			Description: `Paste many keys at once: {"items": [{"secret": "sk-..."}, {"secret": "sk-..."}]}. Each item is applied or refused on its own; read failed and each item's error.`,
			Query:       []api.Param{audit.DryRun},
			Request:     audit.BulkRequest[CreateUpstreamKey]{}, Response: audit.BulkResult[UpstreamKey]{},
			Handle: func(c *api.Call) (any, error) {
				var in audit.BulkRequest[CreateUpstreamKey]
				if err := c.Decode(&in); err != nil {
					return nil, err
				}
				p, err := resolveProvider(c.R.Context(), h.db, c.Path("provider"))
				if err != nil {
					return nil, err
				}
				return audit.Bulk(h.tr, c, "upstream_key.create", "Added", in.Items, func(m *audit.Mutation, in CreateUpstreamKey) (UpstreamKey, error) {
					return h.upsertKey(m, p, in)
				})
			},
		},
		{
			Method: http.MethodPatch, Path: base + "/{key}", Tag: tag,
			Summary: "Rename an Upstream Key or replace its secret",
			Query:   []api.Param{audit.DryRun},
			Request: UpdateUpstreamKey{}, Response: UpstreamKeyResult{},
			Handle: func(c *api.Call) (any, error) {
				var in UpdateUpstreamKey
				if err := c.Decode(&in); err != nil {
					return nil, err
				}
				var out UpstreamKey
				res, err := h.tr.Mutate(c, "upstream_key.update", "Edited", func(m *audit.Mutation) error {
					p, err := resolveProvider(m.Ctx, m.Tx, c.Path("provider"))
					if err != nil {
						return err
					}
					id, err := resolveChild(m.Ctx, m.Tx, "upstream_keys", "Upstream Key", "keys", p, c.Path("key"))
					if err != nil {
						return err
					}
					out, err = h.updateKey(m, p, id, in)
					return err
				})
				return UpstreamKeyResult{Result: res, UpstreamKey: out}, err
			},
		},
		{
			Method: http.MethodDelete, Path: base + "/{key}", Tag: tag,
			Summary:     "Delete an Upstream Key",
			Description: "Revertible through its Audit Entry.",
			Query:       []api.Param{audit.DryRun},
			Response:    UpstreamKeyResult{},
			Handle: func(c *api.Call) (any, error) {
				var out UpstreamKey
				res, err := h.tr.Mutate(c, "upstream_key.delete", "Deleted", func(m *audit.Mutation) error {
					p, err := resolveProvider(m.Ctx, m.Tx, c.Path("provider"))
					if err != nil {
						return err
					}
					out, err = h.deleteKey(m, p, c.Path("key"))
					return err
				})
				return UpstreamKeyResult{Result: res, UpstreamKey: out}, err
			},
		},
		{
			Method: http.MethodPost, Path: base + "/bulk/delete", Tag: tag,
			Summary:     "Delete many Upstream Keys of a Provider, each by name or ID",
			Description: `Body {"items": ["key-1", "uk_..."]}. Each item is applied or refused on its own; one Audit Entry reverts them all.`,
			Query:       []api.Param{audit.DryRun},
			Request:     audit.BulkRequest[string]{}, Response: audit.BulkResult[UpstreamKey]{},
			Handle: func(c *api.Call) (any, error) {
				var in audit.BulkRequest[string]
				if err := c.Decode(&in); err != nil {
					return nil, err
				}
				p, err := resolveProvider(c.R.Context(), h.db, c.Path("provider"))
				if err != nil {
					return nil, err
				}
				return audit.Bulk(h.tr, c, "upstream_key.delete", "Deleted", in.Items, func(m *audit.Mutation, s string) (UpstreamKey, error) {
					return h.deleteKey(m, p, s)
				})
			},
		},
	}
}

// secretFree refuses a secret another key of the same Provider holds.
func secretFree(ctx context.Context, q audit.Querier, p ref, secret, id string) error {
	if secret == "" {
		return nil
	}
	var other string
	err := q.QueryRowContext(ctx, `SELECT name FROM upstream_keys WHERE provider_id = ? AND secret = ? AND id != ?`, p.id, secret, id).Scan(&other)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	return api.Conflict("upstream_key_duplicate", fmt.Sprintf("Address that key as %s (GET /api/providers/%s/keys/%s) instead of adding it again.", other, p.handle, other),
		"Provider %s already holds this secret as Upstream Key %q.", p.handle, other)
}

func (h handlers) upsertKey(m *audit.Mutation, p ref, in CreateUpstreamKey) (UpstreamKey, error) {
	secret := ""
	if in.Secret != nil {
		var err error
		if secret, err = cleanSecret(*in.Secret); err != nil {
			return UpstreamKey{}, err
		}
	}
	name := in.Name
	if name == "" {
		if secret == "" {
			return UpstreamKey{}, api.BadRequest("Send the key as secret, or give a keyless slot a name.", "An Upstream Key needs a secret or a name.")
		}
		var id string
		err := m.Tx.QueryRowContext(m.Ctx, `SELECT id FROM upstream_keys WHERE provider_id = ? AND secret = ?`, p.id, secret).Scan(&id)
		if err == nil {
			if err := m.Track(KeyResource, id); err != nil {
				return UpstreamKey{}, err
			}
			return readKey(m.Ctx, m.Tx, id)
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return UpstreamKey{}, err
		}
		if name, err = nextKeyName(m.Ctx, m.Tx, p.id); err != nil {
			return UpstreamKey{}, err
		}
	} else {
		if err := api.CheckName("name", name); err != nil {
			return UpstreamKey{}, err
		}
		var id string
		err := m.Tx.QueryRowContext(m.Ctx, `SELECT id FROM upstream_keys WHERE provider_id = ? AND name = ?`, p.id, name).Scan(&id)
		if err == nil {
			return h.updateKey(m, p, id, UpdateUpstreamKey{Secret: in.Secret})
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return UpstreamKey{}, err
		}
	}
	if err := secretFree(m.Ctx, m.Tx, p, secret, ""); err != nil {
		return UpstreamKey{}, err
	}
	id := ids.New("uk")
	if err := m.Track(KeyResource, id); err != nil {
		return UpstreamKey{}, err
	}
	if _, err := m.Tx.ExecContext(m.Ctx, `INSERT INTO upstream_keys (id, provider_id, name, secret, created_at) VALUES (?, ?, ?, ?, ?)`,
		id, p.id, name, secret, store.Millis(m.Now)); err != nil {
		return UpstreamKey{}, err
	}
	return readKey(m.Ctx, m.Tx, id)
}

// nextKeyName is the first free key-N, counting from the number of keys + 1.
func nextKeyName(ctx context.Context, tx *sql.Tx, providerID string) (string, error) {
	var n int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM upstream_keys WHERE provider_id = ?`, providerID).Scan(&n); err != nil {
		return "", err
	}
	for i := n + 1; ; i++ {
		name := fmt.Sprintf("key-%d", i)
		var x int
		err := tx.QueryRowContext(ctx, `SELECT 1 FROM upstream_keys WHERE provider_id = ? AND name = ?`, providerID, name).Scan(&x)
		if errors.Is(err, sql.ErrNoRows) {
			return name, nil
		}
		if err != nil {
			return "", err
		}
	}
}

func (h handlers) updateKey(m *audit.Mutation, p ref, id string, in UpdateUpstreamKey) (UpstreamKey, error) {
	if err := m.Track(KeyResource, id); err != nil {
		return UpstreamKey{}, err
	}
	if in.Name != nil {
		if err := api.CheckName("name", *in.Name); err != nil {
			return UpstreamKey{}, err
		}
		if err := childNameFree(m.Ctx, m.Tx, "upstream_keys", "Upstream Key", p.id, *in.Name, id); err != nil {
			return UpstreamKey{}, err
		}
	}
	if in.Secret != nil {
		s, err := cleanSecret(*in.Secret)
		if err != nil {
			return UpstreamKey{}, err
		}
		if err := secretFree(m.Ctx, m.Tx, p, s, id); err != nil {
			return UpstreamKey{}, err
		}
		in.Secret = &s
	}
	if _, err := m.Tx.ExecContext(m.Ctx, `UPDATE upstream_keys SET name = coalesce(?, name), secret = coalesce(?, secret) WHERE id = ?`,
		in.Name, in.Secret, id); err != nil {
		return UpstreamKey{}, err
	}
	return readKey(m.Ctx, m.Tx, id)
}

func (h handlers) deleteKey(m *audit.Mutation, p ref, s string) (UpstreamKey, error) {
	id, err := resolveChild(m.Ctx, m.Tx, "upstream_keys", "Upstream Key", "keys", p, s)
	if err != nil {
		return UpstreamKey{}, err
	}
	out, err := readKey(m.Ctx, m.Tx, id)
	if err != nil {
		return out, err
	}
	if err := m.Track(KeyResource, id); err != nil {
		return out, err
	}
	_, err = m.Tx.ExecContext(m.Ctx, `DELETE FROM upstream_keys WHERE id = ?`, id)
	return out, err
}
