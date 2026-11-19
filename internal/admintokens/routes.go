package admintokens

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/ids"
	"github.com/hoangvu12/iroha/internal/store"
)

// snapshot is what an Audit Entry records of an Admin Token: its
// configuration, not last_used_at.
type snapshot struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Note      string     `json:"note"`
	Secret    string     `json:"secret"`
	CreatedAt time.Time  `json:"created_at"`
	RevokedAt *time.Time `json:"revoked_at"`
}

// Resource is the Admin Token resource of the audit machinery.
var Resource = audit.Register(&audit.Resource[snapshot]{
	Name: "admin_token", Label: "Admin Token", Plural: "Admin Tokens", Path: "/api/admin-tokens",
	Table: "admin_tokens", Secrets: []string{"secret"},
	NameOf: func(s snapshot) string { return s.Name },
	Load: func(ctx context.Context, q audit.Querier, id string) (*snapshot, error) {
		t, err := byID(ctx, q, id)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		return &snapshot{ID: t.ID, Name: t.Name, Note: t.Note, Secret: t.Secret, CreatedAt: t.CreatedAt, RevokedAt: t.RevokedAt}, nil
	},
	Restore: func(ctx context.Context, tx *sql.Tx, id string, s *snapshot) error {
		if s == nil {
			_, err := tx.ExecContext(ctx, `DELETE FROM admin_tokens WHERE id = ?`, id)
			return err
		}
		if err := nameFree(ctx, tx, s.Name, id); err != nil {
			return err
		}
		var revoked any
		if s.RevokedAt != nil {
			revoked = store.Millis(*s.RevokedAt)
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO admin_tokens (id, name, note, secret, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET name = excluded.name, note = excluded.note, secret = excluded.secret, revoked_at = excluded.revoked_at`,
			id, s.Name, s.Note, s.Secret, store.Millis(s.CreatedAt), revoked)
		return err
	},
})

// nameFree refuses a name used by another token than id.
func nameFree(ctx context.Context, q audit.Querier, name, id string) error {
	var other string
	err := q.QueryRowContext(ctx, `SELECT id FROM admin_tokens WHERE name = ? AND id != ?`, name, id).Scan(&other)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	return api.Conflict("name_taken", "Pick another name, or rename that Admin Token first (PATCH /api/admin-tokens/"+name+").",
		"Another Admin Token (%s) is already named %q.", other, name)
}

// CreateAdminToken is the body of POST /api/admin-tokens and each item of
// POST /api/admin-tokens/bulk.
type CreateAdminToken struct {
	Name string  `json:"name" doc:"Unique name, usually the agent that will hold the token. Repeating a create with an existing name updates that token."`
	Note *string `json:"note,omitempty" doc:"Who holds the token or what it is for. Omit to keep the current note of an existing token."`
}

// UpdateAdminToken is the body of PATCH /api/admin-tokens/{token}.
type UpdateAdminToken struct {
	Name *string `json:"name,omitempty" doc:"New name."`
	Note *string `json:"note,omitempty" doc:"New note."`
}

// TokenResult is the response of a single Admin Token change.
type TokenResult struct {
	audit.Result
	AdminToken Token `json:"admin_token" doc:"The token after the change (on a dry run, as it would be; a new token's ID and secret are then placeholders)."`
}

// TokenList is the response of GET /api/admin-tokens.
type TokenList struct {
	AdminTokens []Token `json:"admin_tokens"`
}

const revokedForever = "Revoked Admin Tokens never work again; create a new token instead."

// Routes returns the Admin Token routes.
func Routes(tr *audit.Trail, db *store.DB) []api.Route {
	h := handlers{tr: tr, db: db}
	const tag = "Admin Tokens"
	return []api.Route{
		{
			Method: http.MethodGet, Path: "/api/admin-tokens", Tag: tag,
			Summary: "List Admin Tokens with their secrets",
			Query: []api.Param{
				{Name: "revoked", Type: "boolean", Description: "true: only revoked tokens; false: only active ones. Default: all."},
			},
			Response: TokenList{},
			Handle:   h.list,
		},
		{
			Method: http.MethodGet, Path: "/api/admin-tokens/{token}", Tag: tag,
			Summary:  "Read an Admin Token, secret included, by name or ID",
			Response: Token{},
			Handle: func(c *api.Call) (any, error) {
				id, err := Resource.Resolve(c.R.Context(), h.db, c.Path("token"))
				if err != nil {
					return nil, err
				}
				return byID(c.R.Context(), h.db, id)
			},
		},
		{
			Method: http.MethodPost, Path: "/api/admin-tokens", Tag: tag,
			Summary:     "Create an Admin Token, or update the one with that name",
			Description: "Answers 201 with the new token (secret included) or 200 when a token of that name exists (outcome updated or unchanged). A revoked name cannot be reused.",
			Query:       []api.Param{audit.DryRun},
			Request:     CreateAdminToken{}, Response: TokenResult{},
			Handle: func(c *api.Call) (any, error) {
				var in CreateAdminToken
				if err := c.Decode(&in); err != nil {
					return nil, err
				}
				var out Token
				res, err := h.tr.Mutate(c, "admin_token.create", "Created", func(m *audit.Mutation) error {
					var err error
					out, err = h.upsert(m, in)
					return err
				})
				return TokenResult{Result: res, AdminToken: out}, err
			},
		},
		{
			Method: http.MethodPost, Path: "/api/admin-tokens/bulk", Tag: tag,
			Summary:     "Create or update many Admin Tokens, each by name",
			Description: "Each item is applied or refused on its own; read failed and each item's error.",
			Query:       []api.Param{audit.DryRun},
			Request:     audit.BulkRequest[CreateAdminToken]{}, Response: audit.BulkResult[Token]{},
			Handle: func(c *api.Call) (any, error) {
				var in audit.BulkRequest[CreateAdminToken]
				if err := c.Decode(&in); err != nil {
					return nil, err
				}
				return audit.Bulk(h.tr, c, "admin_token.create", "Created", in.Items, h.upsert)
			},
		},
		{
			Method: http.MethodPatch, Path: "/api/admin-tokens/{token}", Tag: tag,
			Summary: "Rename an Admin Token or change its note",
			Query:   []api.Param{audit.DryRun},
			Request: UpdateAdminToken{}, Response: TokenResult{},
			Handle: func(c *api.Call) (any, error) {
				var in UpdateAdminToken
				if err := c.Decode(&in); err != nil {
					return nil, err
				}
				var out Token
				res, err := h.tr.Mutate(c, "admin_token.update", "Edited", func(m *audit.Mutation) error {
					id, err := Resource.Resolve(m.Ctx, m.Tx, c.Path("token"))
					if err != nil {
						return err
					}
					out, err = h.update(m, id, in)
					return err
				})
				return TokenResult{Result: res, AdminToken: out}, err
			},
		},
		{
			Method: http.MethodPost, Path: "/api/admin-tokens/{token}/revoke", Tag: tag,
			Summary:     "Revoke an Admin Token, by name or ID",
			Description: "Permanent: the Audit Entry cannot be reverted. Revoking a revoked token changes nothing. The last active token cannot be revoked.",
			Query:       []api.Param{audit.DryRun},
			Response:    TokenResult{},
			Handle: func(c *api.Call) (any, error) {
				var out Token
				res, err := h.tr.Mutate(c, "admin_token.revoke", "Revoked", func(m *audit.Mutation) error {
					var err error
					out, err = h.revoke(m, c.Path("token"))
					return err
				})
				return TokenResult{Result: res, AdminToken: out}, err
			},
		},
		{
			Method: http.MethodPost, Path: "/api/admin-tokens/bulk/revoke", Tag: tag,
			Summary:     "Revoke many Admin Tokens, each by name or ID",
			Description: `Body {"items": ["agent-1", "at_..."]}. Each item is applied or refused on its own.`,
			Query:       []api.Param{audit.DryRun},
			Request:     audit.BulkRequest[string]{}, Response: audit.BulkResult[Token]{},
			Handle: func(c *api.Call) (any, error) {
				var in audit.BulkRequest[string]
				if err := c.Decode(&in); err != nil {
					return nil, err
				}
				return audit.Bulk(h.tr, c, "admin_token.revoke", "Revoked", in.Items, h.revoke)
			},
		},
	}
}

type handlers struct {
	tr *audit.Trail
	db *store.DB
}

func (h handlers) list(c *api.Call) (any, error) {
	q := `SELECT ` + tokenColumns + ` FROM admin_tokens`
	switch c.Query("revoked") {
	case "":
	case "true":
		q += ` WHERE revoked_at IS NOT NULL`
	case "false":
		q += ` WHERE revoked_at IS NULL`
	default:
		return nil, api.BadRequest("Use revoked=true, revoked=false, or leave it out for all tokens.", "revoked must be true or false.")
	}
	rows, err := h.db.QueryContext(c.R.Context(), q+` ORDER BY created_at, rowid`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := TokenList{AdminTokens: []Token{}}
	for rows.Next() {
		t, err := scanToken(rows)
		if err != nil {
			return nil, err
		}
		out.AdminTokens = append(out.AdminTokens, t)
	}
	return out, rows.Err()
}

// upsert creates the token named in.Name, or updates the existing one.
func (h handlers) upsert(m *audit.Mutation, in CreateAdminToken) (Token, error) {
	if err := api.CheckName("name", in.Name); err != nil {
		return Token{}, err
	}
	var id string
	err := m.Tx.QueryRowContext(m.Ctx, `SELECT id FROM admin_tokens WHERE name = ?`, in.Name).Scan(&id)
	if err == nil {
		t, err := byID(m.Ctx, m.Tx, id)
		if err != nil {
			return t, err
		}
		if t.Revoked {
			return t, api.Conflict("admin_token_revoked", "Pick another name for the new token; revoked tokens and their names stay as a record.",
				"The Admin Token %q was revoked; it cannot be created again.", in.Name)
		}
		return h.update(m, id, UpdateAdminToken{Note: in.Note})
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Token{}, err
	}
	id = ids.New("at")
	if err := m.Track(Resource, id); err != nil {
		return Token{}, err
	}
	note := ""
	if in.Note != nil {
		note = *in.Note
	}
	if _, err := m.Tx.ExecContext(m.Ctx, `INSERT INTO admin_tokens (id, name, note, secret, created_at) VALUES (?, ?, ?, ?, ?)`,
		id, in.Name, note, ids.Secret(SecretPrefix), store.Millis(m.Now)); err != nil {
		return Token{}, err
	}
	return byID(m.Ctx, m.Tx, id)
}

func (h handlers) update(m *audit.Mutation, id string, in UpdateAdminToken) (Token, error) {
	if err := m.Track(Resource, id); err != nil {
		return Token{}, err
	}
	if in.Name != nil {
		if err := api.CheckName("name", *in.Name); err != nil {
			return Token{}, err
		}
		if err := nameFree(m.Ctx, m.Tx, *in.Name, id); err != nil {
			return Token{}, err
		}
		if _, err := m.Tx.ExecContext(m.Ctx, `UPDATE admin_tokens SET name = ? WHERE id = ?`, *in.Name, id); err != nil {
			return Token{}, err
		}
	}
	if in.Note != nil {
		if _, err := m.Tx.ExecContext(m.Ctx, `UPDATE admin_tokens SET note = ? WHERE id = ?`, *in.Note, id); err != nil {
			return Token{}, err
		}
	}
	return byID(m.Ctx, m.Tx, id)
}

func (h handlers) revoke(m *audit.Mutation, ref string) (Token, error) {
	id, err := Resource.Resolve(m.Ctx, m.Tx, ref)
	if err != nil {
		return Token{}, err
	}
	t, err := byID(m.Ctx, m.Tx, id)
	if err != nil || t.Revoked {
		return t, err
	}
	// Until the Owner can log in with a password, the last active token is
	// the only way in; revoking it would lock everyone out.
	var others int
	if err := m.Tx.QueryRowContext(m.Ctx, `SELECT count(*) FROM admin_tokens WHERE revoked_at IS NULL AND id != ?`, id).Scan(&others); err != nil {
		return t, err
	}
	if others == 0 {
		return t, api.Conflict("last_admin_token", "Create another Admin Token first (POST /api/admin-tokens), then revoke this one.",
			"%q is the last active Admin Token; revoking it would lock everyone out.", t.Name)
	}
	if err := m.Track(Resource, id); err != nil {
		return t, err
	}
	m.Irreversible(revokedForever)
	if _, err := m.Tx.ExecContext(m.Ctx, `UPDATE admin_tokens SET revoked_at = ? WHERE id = ?`, store.Millis(m.Now), id); err != nil {
		return t, err
	}
	return byID(m.Ctx, m.Tx, id)
}
