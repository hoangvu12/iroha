// Package session is the Owner's login: one Owner password, browser
// sessions that last 30 days, the authenticator that lets a session act as
// the Owner on admin routes, and the routes that set the password, sign in
// and out, and list and revoke sessions.
package session

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/clock"
	"github.com/hoangvu12/iroha/internal/logs"
	"github.com/hoangvu12/iroha/internal/store"
)

// CookieName is the cookie holding a session's secret.
const CookieName = "iroha_session"

// Lifetime is how long a session lasts from sign-in.
const Lifetime = 30 * 24 * time.Hour

// OwnerName is the actor name of every Owner session in Audit Entries.
const OwnerName = "Owner"

// secretPrefix starts every session secret.
const secretPrefix = "iroha_session"

// Log event kinds.
var (
	KindLogin       = logs.NewKind("owner.login", "The Owner signed in; names the new session.")
	KindLoginFailed = logs.NewKind("owner.login_failed", "A sign-in with a wrong Owner password, or one refused because of too many recent failures.")
	KindLogout      = logs.NewKind("owner.logout", "The Owner signed out of a session.")
)

// OwnerSession is an Owner session as the API shows it. Its secret is never
// shown; it lives only in the browser's cookie.
type OwnerSession struct {
	ID         string     `json:"id"`
	UserAgent  string     `json:"user_agent" doc:"The browser that signed in."`
	CreatedAt  time.Time  `json:"created_at"`
	ExpiresAt  time.Time  `json:"expires_at" doc:"30 days after sign-in."`
	LastSeenAt *time.Time `json:"last_seen_at,omitempty" doc:"Last use, to the minute."`
	Active     bool       `json:"active" doc:"true when neither revoked nor expired."`
	RevokedAt  *time.Time `json:"revoked_at,omitempty"`
	Current    bool       `json:"current" doc:"true for the session making this call."`
}

// Store reads and writes the Owner password and sessions.
type Store struct {
	db    *store.DB
	clock clock.Clock
	log   *slog.Logger
	limit limiter
}

// New returns a Store.
func New(db *store.DB, log *slog.Logger) *Store {
	return &Store{db: db, clock: db.Clock(), log: log}
}

const sessionColumns = `id, user_agent, created_at, expires_at, last_seen_at, revoked_at`

func scanSession(row interface{ Scan(...any) error }, now time.Time) (OwnerSession, error) {
	var x OwnerSession
	var created, expires int64
	var seen, revoked sql.NullInt64
	if err := row.Scan(&x.ID, &x.UserAgent, &created, &expires, &seen, &revoked); err != nil {
		return x, err
	}
	x.CreatedAt, x.ExpiresAt = store.FromMillis(created), store.FromMillis(expires)
	if seen.Valid {
		at := store.FromMillis(seen.Int64)
		x.LastSeenAt = &at
	}
	if revoked.Valid {
		at := store.FromMillis(revoked.Int64)
		x.RevokedAt = &at
	}
	x.Active = x.RevokedAt == nil && now.Before(x.ExpiresAt)
	return x, nil
}

func sessionByID(ctx context.Context, q audit.Querier, id string, now time.Time) (OwnerSession, error) {
	return scanSession(q.QueryRowContext(ctx, `SELECT `+sessionColumns+` FROM owner_sessions WHERE id = ?`, id), now)
}

// PasswordSet reports whether the Owner has set a password. Other packages
// use it to decide whether the Owner can still get in (the last Admin Token
// guard).
func PasswordSet(ctx context.Context, q audit.Querier) (bool, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT count(*) FROM owner_password`).Scan(&n)
	return n > 0, err
}

// passwordHash returns the stored hash; sql.ErrNoRows when none is set.
func passwordHash(ctx context.Context, q audit.Querier) (string, error) {
	var hash string
	err := q.QueryRowContext(ctx, `SELECT hash FROM owner_password WHERE id = 'owner'`).Scan(&hash)
	return hash, err
}

// fromCookie returns the session whose secret the request's cookie holds,
// with sql.ErrNoRows when there is no cookie or no such session.
func (s *Store) fromCookie(r *http.Request) (OwnerSession, error) {
	c, err := r.Cookie(CookieName)
	if err != nil || c.Value == "" {
		return OwnerSession{}, sql.ErrNoRows
	}
	return scanSession(s.db.QueryRowContext(r.Context(),
		`SELECT `+sessionColumns+` FROM owner_sessions WHERE secret_hash = ?`, secretHash(c.Value)), s.clock.Now())
}


// Authenticator recognises the session cookie. A session acts as the Owner
// (actor kind owner_session, name "Owner"). A changing call from another
// site is refused, so a page elsewhere cannot use the Owner's cookie.
func (s *Store) Authenticator() api.Authenticator {
	return api.AuthenticatorFunc(func(r *http.Request) (*api.Actor, error) {
		if c, err := r.Cookie(CookieName); err != nil || c.Value == "" {
			return nil, nil
		}
		x, err := s.fromCookie(r)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, sessionError("owner_session_invalid", "This browser's Owner session is not known to Iroha.")
		}
		if err != nil {
			return nil, err
		}
		now := s.clock.Now()
		switch {
		case x.RevokedAt != nil:
			return nil, sessionError("owner_session_revoked", "This Owner session was revoked at "+x.RevokedAt.Format(time.RFC3339)+".")
		case !x.Active:
			return nil, sessionError("owner_session_expired", "This Owner session expired at "+x.ExpiresAt.Format(time.RFC3339)+".")
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Header.Get("Sec-Fetch-Site") == "cross-site" {
			return nil, &api.Error{Status: http.StatusForbidden, Code: "cross_site_request",
				Message: "A page on another site tried to change Iroha with the Owner's session.",
				Hint:    "Make changes from Iroha's own pages, or send an Admin Token instead of the session cookie."}
		}
		_ = s.db.Touch(r.Context(), "owner_sessions", "last_seen_at", x.ID, x.LastSeenAt, now, store.TouchEvery)
		return &api.Actor{Kind: api.ActorOwnerSession, ID: x.ID, Name: OwnerName}, nil
	})
}

func sessionError(code, msg string) *api.Error {
	return &api.Error{Status: http.StatusUnauthorized, Code: code, Message: msg,
		Hint: "Sign in again with the Owner password (POST /api/session, or the login page), or send an Admin Token."}
}

// cookie builds the session cookie; maxAge < 0 deletes it. It is Secure when
// the browser reached Iroha over HTTPS: TLS here, or the first (client-side)
// value of X-Forwarded-Proto when a chain of proxies lists several.
func cookie(r *http.Request, value string, maxAge int) *http.Cookie {
	proto, _, _ := strings.Cut(r.Header.Get("X-Forwarded-Proto"), ",")
	secure := r.TLS != nil || strings.EqualFold(strings.TrimSpace(proto), "https")
	return &http.Cookie{Name: CookieName, Value: value, Path: "/", MaxAge: maxAge,
		HttpOnly: true, Secure: secure, SameSite: http.SameSiteStrictMode}
}

// limiter refuses sign-ins after too many recent failures. It is global, not
// per address: behind a proxy the client address can be forged, and the
// Owner can always get in with an Admin Token.
type limiter struct {
	mu    sync.Mutex
	fails []time.Time
}

const (
	maxFailures   = 10
	failureWindow = 15 * time.Minute
)

func (l *limiter) prune(now time.Time) {
	i := 0
	for i < len(l.fails) && now.Sub(l.fails[i]) >= failureWindow {
		i++
	}
	l.fails = l.fails[i:]
}

// blocked returns how long sign-in stays refused, or 0.
func (l *limiter) blocked(now time.Time) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.prune(now)
	if len(l.fails) < maxFailures {
		return 0
	}
	return l.fails[0].Add(failureWindow).Sub(now)
}

func (l *limiter) fail(now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.prune(now)
	l.fails = append(l.fails, now)
}
