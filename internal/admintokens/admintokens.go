// Package admintokens stores Admin Tokens, authenticates admin calls with
// them, issues the bootstrap token on first start, and serves the
// /api/admin-tokens routes (the first resource built on package audit).
package admintokens

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/clock"
	"github.com/hoangvu12/iroha/internal/ids"
	"github.com/hoangvu12/iroha/internal/logs"
	"github.com/hoangvu12/iroha/internal/store"
)

// BootstrapName is the name of the token created on first start.
const BootstrapName = "bootstrap"

// SecretPrefix starts every Admin Token secret.
const SecretPrefix = "iroha_admin"

// KindBootstrap is logged when the bootstrap token is created.
var KindBootstrap = logs.NewKind("admin_token.bootstrap", "The bootstrap Admin Token was created on first start; its secret is printed to the console once and never logged.")

// Token is an Admin Token as stored and as the API returns it.
type Token struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Note       string     `json:"note" doc:"Who holds the token or what it is for."`
	Secret     string     `json:"secret" doc:"The token itself; send it as \"Authorization: Bearer <secret>\"."`
	Revoked    bool       `json:"revoked"`
	CreatedAt  time.Time  `json:"created_at"`
	RevokedAt  *time.Time `json:"revoked_at,omitempty"`
	LastUsedAt *time.Time `json:"last_used_at,omitempty" doc:"Last use, to the minute; absent when never used."`
}

// Store reads and writes admin_tokens.
type Store struct {
	db    *store.DB
	clock clock.Clock
}

// New returns a Store.
func New(db *store.DB) *Store { return &Store{db: db, clock: db.Clock()} }

const tokenColumns = `id, name, note, secret, created_at, revoked_at, last_used_at`

func scanToken(row interface{ Scan(...any) error }) (Token, error) {
	var t Token
	var created int64
	var revoked, used sql.NullInt64
	if err := row.Scan(&t.ID, &t.Name, &t.Note, &t.Secret, &created, &revoked, &used); err != nil {
		return t, err
	}
	t.CreatedAt = store.FromMillis(created)
	if revoked.Valid {
		at := store.FromMillis(revoked.Int64)
		t.RevokedAt, t.Revoked = &at, true
	}
	if used.Valid {
		at := store.FromMillis(used.Int64)
		t.LastUsedAt = &at
	}
	return t, nil
}

// byID reads one token; sql.ErrNoRows when absent.
func byID(ctx context.Context, q audit.Querier, id string) (Token, error) {
	return scanToken(q.QueryRowContext(ctx, `SELECT `+tokenColumns+` FROM admin_tokens WHERE id = ?`, id))
}

// BySecret finds a token by its secret.
func (s *Store) BySecret(ctx context.Context, secret string) (Token, error) {
	return scanToken(s.db.QueryRowContext(ctx, `SELECT `+tokenColumns+` FROM admin_tokens WHERE secret = ?`, secret))
}

const bootstrapMetaKey = "bootstrap_admin_token_issued_at"

// Bootstrap creates the bootstrap token on the first start of an
// installation and returns it with created=true. On every later start it
// returns created=false, even if that token was revoked.
func (s *Store) Bootstrap(ctx context.Context) (tok Token, created bool, err error) {
	err = s.db.Tx(ctx, func(tx *sql.Tx) error {
		var v string
		err := tx.QueryRowContext(ctx, `SELECT value FROM meta WHERE key = ?`, bootstrapMetaKey).Scan(&v)
		if err == nil {
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		now := s.clock.Now().UTC()
		tok = Token{ID: ids.New("at"), Name: BootstrapName, Secret: ids.Secret(SecretPrefix), CreatedAt: now}
		if _, err := tx.ExecContext(ctx, `INSERT INTO admin_tokens (id, name, secret, created_at) VALUES (?, ?, ?, ?)`,
			tok.ID, tok.Name, tok.Secret, store.Millis(now)); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO meta (key, value) VALUES (?, ?)`, bootstrapMetaKey, now.Format(time.RFC3339)); err != nil {
			return err
		}
		created = true
		return nil
	})
	return tok, created, err
}


// Authenticator recognises "Authorization: Bearer iroha_admin_...".
func (s *Store) Authenticator() api.Authenticator {
	return api.AuthenticatorFunc(func(r *http.Request) (*api.Actor, error) {
		secret := api.BearerToken(r)
		if secret == "" {
			return nil, nil
		}
		t, err := s.BySecret(r.Context(), secret)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, &api.Error{
				Status:  http.StatusUnauthorized,
				Code:    "admin_token_invalid",
				Message: "The bearer token is not an Admin Token of this Iroha.",
				Hint:    "Check that you copied the whole Admin Token (it starts with " + SecretPrefix + "_). A Gateway Key does not work on admin routes.",
			}
		}
		if err != nil {
			return nil, err
		}
		if t.Revoked {
			return nil, &api.Error{
				Status:  http.StatusUnauthorized,
				Code:    "admin_token_revoked",
				Message: "The Admin Token \"" + t.Name + "\" was revoked at " + t.RevokedAt.Format(time.RFC3339) + ".",
				Hint:    "Ask the Owner for a new Admin Token; revoked tokens never work again.",
			}
		}
		_ = s.db.Touch(r.Context(), "admin_tokens", "last_used_at", t.ID, t.LastUsedAt, s.clock.Now(), store.TouchEvery)
		return &api.Actor{Kind: api.ActorAdminToken, ID: t.ID, Name: t.Name}, nil
	})
}
