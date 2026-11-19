// Package admintokens stores Admin Tokens, authenticates admin calls with
// them and issues the bootstrap token on first start. The admin routes for
// managing tokens arrive with ticket 02.
package admintokens

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
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

// Token is a stored Admin Token.
type Token struct {
	ID         string
	Name       string
	Secret     string
	CreatedAt  time.Time
	RevokedAt  time.Time // zero when active
	LastUsedAt time.Time // zero when never used
}

// Store reads and writes admin_tokens.
type Store struct {
	db    *store.DB
	clock clock.Clock
}

// New returns a Store.
func New(db *store.DB) *Store { return &Store{db: db, clock: db.Clock()} }

// Create makes a new active token named name.
func (s *Store) Create(ctx context.Context, name string) (Token, error) {
	t := Token{ID: ids.New("at"), Name: name, Secret: ids.Secret(SecretPrefix), CreatedAt: s.clock.Now().UTC()}
	_, err := s.db.ExecContext(ctx, `INSERT INTO admin_tokens (id, name, secret, created_at) VALUES (?, ?, ?, ?)`,
		t.ID, t.Name, t.Secret, store.Millis(t.CreatedAt))
	return t, err
}

// Revoke revokes the token named name. Revoking twice is harmless.
func (s *Store) Revoke(ctx context.Context, name string) error {
	res, err := s.db.ExecContext(ctx, `UPDATE admin_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE name = ?`,
		store.Millis(s.clock.Now()), name)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// BySecret finds a token by its secret.
func (s *Store) BySecret(ctx context.Context, secret string) (Token, error) {
	var t Token
	var created int64
	var revoked, used sql.NullInt64
	err := s.db.QueryRowContext(ctx, `SELECT id, name, secret, created_at, revoked_at, last_used_at FROM admin_tokens WHERE secret = ?`, secret).
		Scan(&t.ID, &t.Name, &t.Secret, &created, &revoked, &used)
	if err != nil {
		return t, err
	}
	t.CreatedAt, t.RevokedAt, t.LastUsedAt = store.FromMillis(created), store.NullMillis(revoked), store.NullMillis(used)
	return t, nil
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

// lastUsedGranularity limits last_used_at writes to one per token per minute.
const lastUsedGranularity = time.Minute

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
		if !t.RevokedAt.IsZero() {
			return nil, &api.Error{
				Status:  http.StatusUnauthorized,
				Code:    "admin_token_revoked",
				Message: "The Admin Token \"" + t.Name + "\" was revoked at " + t.RevokedAt.Format(time.RFC3339) + ".",
				Hint:    "Ask the Owner for a new Admin Token; revoked tokens never work again.",
			}
		}
		now := s.clock.Now()
		if now.Sub(t.LastUsedAt) >= lastUsedGranularity {
			_, _ = s.db.ExecContext(r.Context(), `UPDATE admin_tokens SET last_used_at = ? WHERE id = ?`, store.Millis(now), t.ID)
		}
		return &api.Actor{Kind: api.ActorAdminToken, ID: t.ID, Name: t.Name}, nil
	})
}
