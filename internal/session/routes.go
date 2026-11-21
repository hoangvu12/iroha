package session

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/ids"
	"github.com/hoangvu12/iroha/internal/logs"
	"github.com/hoangvu12/iroha/internal/store"
)

type passwordSnapshot struct {
	ID    string    `json:"id"`
	Name  string    `json:"name"`
	Hash  string    `json:"hash"`
	SetAt time.Time `json:"set_at"`
}

const passwordIrreversible = "A password change cannot be undone; set the password again with PUT /api/owner-password."

// PasswordResource is the Owner password in the audit machinery. Changes to
// it are irreversible, so Restore never runs.
var PasswordResource = audit.Register(&audit.Resource[passwordSnapshot]{
	Name: "owner_password", Label: "Owner password", Plural: "Owner passwords", Path: "/api/session",
	Table: "owner_password", Secrets: []string{"hash"},
	NameOf: func(s passwordSnapshot) string { return s.Name },
	Load: func(ctx context.Context, q audit.Querier, id string) (*passwordSnapshot, error) {
		var s passwordSnapshot
		var at int64
		err := q.QueryRowContext(ctx, `SELECT id, name, hash, set_at FROM owner_password WHERE id = ?`, id).Scan(&s.ID, &s.Name, &s.Hash, &at)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		s.SetAt = store.FromMillis(at)
		return &s, err
	},
	Restore: func(ctx context.Context, tx *sql.Tx, id string, s *passwordSnapshot) error {
		return api.Conflict("audit_irreversible", passwordIrreversible, "Owner password changes cannot be reverted.")
	},
})

type sessionSnapshot struct {
	ID        string     `json:"id"`
	UserAgent string     `json:"user_agent"`
	CreatedAt time.Time  `json:"created_at"`
	ExpiresAt time.Time  `json:"expires_at"`
	RevokedAt *time.Time `json:"revoked_at"`
}

const sessionIrreversible = "Revoked Owner sessions never work again; sign in again instead."

// SessionResource is an Owner session in the audit machinery. Only revoking
// one is audited (signing in and out are logged), and that cannot be undone.
var SessionResource = audit.Register(&audit.Resource[sessionSnapshot]{
	Name: "owner_session", Label: "Owner session", Plural: "Owner sessions", Path: "/api/owner-sessions",
	Table: "owner_sessions", NameColumn: "id",
	NameOf: func(s sessionSnapshot) string { return s.ID },
	Load: func(ctx context.Context, q audit.Querier, id string) (*sessionSnapshot, error) {
		x, err := sessionByID(ctx, q, id, time.Time{})
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		return &sessionSnapshot{ID: x.ID, UserAgent: x.UserAgent, CreatedAt: x.CreatedAt, ExpiresAt: x.ExpiresAt, RevokedAt: x.RevokedAt}, nil
	},
	Restore: func(ctx context.Context, tx *sql.Tx, id string, s *sessionSnapshot) error {
		return api.Conflict("audit_irreversible", sessionIrreversible, "Owner session changes cannot be reverted.")
	},
})

// SessionStatus is the response of GET /api/session and POST /api/session.
type SessionStatus struct {
	PasswordSet bool          `json:"password_set" doc:"false until the Owner password is set (PUT /api/owner-password)."`
	SignedIn    bool          `json:"signed_in" doc:"true when this browser's session cookie is an active Owner session."`
	Session     *OwnerSession `json:"session,omitempty"`
}

// SignIn is the body of POST /api/session.
type SignIn struct {
	Password string `json:"password"`
}

// SetOwnerPassword is the body of PUT /api/owner-password.
type SetOwnerPassword struct {
	Password        string  `json:"password" doc:"The new password, at least 8 characters."`
	CurrentPassword *string `json:"current_password,omitempty" doc:"Required when an Owner session changes an existing password; Admin Tokens need not send it."`
}

// OwnerPassword says whether and when the password was set.
type OwnerPassword struct {
	Set   bool       `json:"set"`
	SetAt *time.Time `json:"set_at,omitempty"`
}

// OwnerPasswordResult is the response of PUT /api/owner-password.
type OwnerPasswordResult struct {
	audit.Result
	OwnerPassword OwnerPassword `json:"owner_password"`
}

// OwnerSessionList is the response of GET /api/owner-sessions.
type OwnerSessionList struct {
	OwnerSessions []OwnerSession `json:"owner_sessions"`
}

// OwnerSessionResult is the response of revoking one session.
type OwnerSessionResult struct {
	audit.Result
	OwnerSession OwnerSession `json:"owner_session"`
}

func Routes(s *Store, tr *audit.Trail) []api.Route {
	h := handlers{s: s, tr: tr}
	const tag = "Owner login"
	return []api.Route{
		{
			Method: http.MethodGet, Path: "/api/session", Tag: tag, Auth: api.AuthPublic,
			Summary:     "Say whether an Owner password is set and whether this browser is signed in",
			Description: "The UI calls this first: no password yet means the setup screen, otherwise the login screen or the app.",
			Response:    SessionStatus{},
			Handle:      h.status,
		},
		{
			Method: http.MethodPost, Path: "/api/session", Tag: tag, Auth: api.AuthPublic,
			Summary:     "Sign in as the Owner with the Owner password",
			Description: "Answers 201 and sets the `iroha_session` cookie (HttpOnly, SameSite=Strict) for 30 days. Wrong passwords answer 401 `owner_password_wrong`; after 10 failures in 15 minutes every sign-in answers 429 `too_many_attempts` with Retry-After. Agents use Admin Tokens instead.",
			Request:     SignIn{}, Response: SessionStatus{}, Status: http.StatusCreated,
			Handle: h.login,
		},
		{
			Method: http.MethodDelete, Path: "/api/session", Tag: tag, Auth: api.AuthPublic,
			Summary:     "Sign out: end this browser's Owner session",
			Description: "Revokes the session in the cookie, if any, and deletes the cookie. Answers 204 either way.",
			Handle:      h.logout,
		},
		{
			Method: http.MethodPut, Path: "/api/owner-password", Tag: tag,
			Summary:     "Set or change the Owner password",
			Description: "The first set needs an Admin Token (the login page asks for one on first visit). Changing it from an Owner session needs `current_password`. Every other active Owner session is revoked. Irreversible: the Audit Entry cannot be reverted.",
			Query:       []api.Param{audit.DryRun},
			Request:     SetOwnerPassword{}, Response: OwnerPasswordResult{},
			Handle: h.setPassword,
		},
		{
			Method: http.MethodGet, Path: "/api/owner-sessions", Tag: tag,
			Summary: "List Owner sessions, newest first",
			Query: []api.Param{
				{Name: "active", Type: "boolean", Description: "true: only sessions that still work; false: only revoked or expired ones. Default: all."},
			},
			Response: OwnerSessionList{},
			Handle:   h.list,
		},
		{
			Method: http.MethodPost, Path: "/api/owner-sessions/{session}/revoke", Tag: tag,
			Summary:     "Revoke an Owner session by ID",
			Description: "The browser holding it is signed out on its next call. Permanent: the Audit Entry cannot be reverted.",
			Query:       []api.Param{audit.DryRun},
			Response:    OwnerSessionResult{},
			Handle: func(c *api.Call) (any, error) {
				var out OwnerSession
				res, err := h.tr.Mutate(c, "owner_session.revoke", "Revoked", func(m *audit.Mutation) error {
					var err error
					out, err = h.revoke(m, c.Path("session"))
					return err
				})
				out.Current = isCurrent(c, out.ID)
				return OwnerSessionResult{Result: res, OwnerSession: out}, err
			},
		},
		{
			Method: http.MethodPost, Path: "/api/owner-sessions/bulk/revoke", Tag: tag,
			Summary:     "Revoke many Owner sessions by ID",
			Description: `Body {"items": ["os_...", "os_..."]}. Each item is applied or refused on its own.`,
			Query:       []api.Param{audit.DryRun},
			Request:     audit.BulkRequest[string]{}, Response: audit.BulkResult[OwnerSession]{},
			Handle: func(c *api.Call) (any, error) {
				var in audit.BulkRequest[string]
				if err := c.Decode(&in); err != nil {
					return nil, err
				}
				return audit.Bulk(h.tr, c, "owner_session.revoke", "Revoked", in.Items, h.revoke)
			},
		},
	}
}

type handlers struct {
	s  *Store
	tr *audit.Trail
}

func isCurrent(c *api.Call, id string) bool {
	return c.Actor.Kind == api.ActorOwnerSession && c.Actor.ID == id
}

func (h handlers) status(c *api.Call) (any, error) {
	ctx := c.R.Context()
	set, err := PasswordSet(ctx, h.s.db)
	if err != nil {
		return nil, err
	}
	out := SessionStatus{PasswordSet: set}
	x, err := h.s.fromCookie(c.R)
	switch {
	case err == nil && x.Active:
		x.Current = true
		out.SignedIn, out.Session = true, &x
	case err != nil && !errors.Is(err, sql.ErrNoRows):
		return nil, err
	}
	return out, nil
}

const maxUserAgent = 300

func (h handlers) login(c *api.Call) (any, error) {
	var in SignIn
	if err := c.Decode(&in); err != nil {
		return nil, err
	}
	ctx, now := c.R.Context(), h.s.clock.Now()
	if wait := h.s.limit.blocked(now); wait > 0 {
		secs := int(math.Ceil(wait.Seconds()))
		c.W.Header().Set("Retry-After", strconv.Itoa(secs))
		h.s.log.Warn("sign-in refused: too many failures", logs.Kind(KindLoginFailed), "reason", "rate_limited")
		return nil, api.Errorf(http.StatusTooManyRequests, "too_many_attempts",
			"Wait "+strconv.Itoa(secs)+" s (Retry-After) and try again, or use an Admin Token.",
			"Too many wrong passwords in the last %d minutes.", int(failureWindow.Minutes()))
	}
	hash, err := passwordHash(ctx, h.s.db)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, api.Conflict("owner_password_not_set",
			"Set it first: PUT /api/owner-password with an Admin Token (the login page does this on first visit).",
			"No Owner password has been set yet.")
	}
	if err != nil {
		return nil, err
	}
	ok, err := verifyPassword(hash, in.Password)
	if err != nil {
		return nil, err
	}
	if !ok {
		h.s.limit.fail(now)
		h.s.log.Warn("sign-in with a wrong password", logs.Kind(KindLoginFailed), "reason", "wrong_password")
		return nil, api.Errorf(http.StatusUnauthorized, "owner_password_wrong",
			"Check the password and try again. An agent can set a new one with PUT /api/owner-password.",
			"That is not the Owner password.")
	}
	secret, id := secretFor(), ids.New("os")
	ua := c.R.UserAgent()
	if len(ua) > maxUserAgent {
		ua = ua[:maxUserAgent]
	}
	err = h.s.db.Tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO owner_sessions (id, secret_hash, user_agent, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)`,
			id, secretHash(secret), ua, store.Millis(now), store.Millis(now.Add(Lifetime)), store.Millis(now))
		return err
	})
	if err != nil {
		return nil, err
	}
	x, err := sessionByID(ctx, h.s.db, id, now)
	if err != nil {
		return nil, err
	}
	x.Current = true
	http.SetCookie(c.W, cookie(c.R, secret, int(Lifetime/time.Second)))
	h.s.log.Info("Owner signed in", logs.Kind(KindLogin), "session", id)
	return SessionStatus{PasswordSet: true, SignedIn: true, Session: &x}, nil
}

func secretFor() string { return ids.Secret(secretPrefix) }

func (h handlers) logout(c *api.Call) (any, error) {
	ctx := c.R.Context()
	x, err := h.s.fromCookie(c.R)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if err == nil && x.RevokedAt == nil {
		now := h.s.clock.Now()
		if err := h.s.db.Tx(ctx, func(tx *sql.Tx) error {
			_, err := tx.ExecContext(ctx, `UPDATE owner_sessions SET revoked_at = ? WHERE id = ?`, store.Millis(now), x.ID)
			return err
		}); err != nil {
			return nil, err
		}
		h.s.log.Info("Owner signed out", logs.Kind(KindLogout), "session", x.ID)
	}
	http.SetCookie(c.W, cookie(c.R, "", -1))
	return nil, nil
}

func (h handlers) setPassword(c *api.Call) (any, error) {
	var in SetOwnerPassword
	if err := c.Decode(&in); err != nil {
		return nil, err
	}
	if err := checkPassword("password", in.Password); err != nil {
		return nil, err
	}
	newHash, err := hashPassword(in.Password)
	if err != nil {
		return nil, err
	}
	var out OwnerPassword
	res, err := h.tr.Mutate(c, "owner_password.set", "Set", func(m *audit.Mutation) error {
		old, err := passwordHash(m.Ctx, m.Tx)
		had := err == nil
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if had && m.Actor.Kind == api.ActorOwnerSession {
			if in.CurrentPassword == nil {
				return api.BadRequest("Send current_password with the password now in use.", "current_password is required to change the Owner password from a session.")
			}
			ok, err := verifyPassword(old, *in.CurrentPassword)
			if err != nil {
				return err
			}
			if !ok {
				return api.Errorf(http.StatusForbidden, "owner_password_wrong", "Check current_password and try again.", "current_password is not the Owner password.")
			}
		}
		if err := m.Track(PasswordResource, "owner"); err != nil {
			return err
		}
		if _, err := m.Tx.ExecContext(m.Ctx, `INSERT INTO owner_password (id, hash, set_at) VALUES ('owner', ?, ?)
			ON CONFLICT (id) DO UPDATE SET hash = excluded.hash, set_at = excluded.set_at`, newHash, store.Millis(m.Now)); err != nil {
			return err
		}
		callerSessionID := ""
		if m.Actor.Kind == api.ActorOwnerSession {
			callerSessionID = m.Actor.ID
		}
		others, err := activeSessionIDs(m.Ctx, m.Tx, m.Now, callerSessionID)
		if err != nil {
			return err
		}
		for _, id := range others {
			if err := m.Track(SessionResource, id); err != nil {
				return err
			}
			if _, err := m.Tx.ExecContext(m.Ctx, `UPDATE owner_sessions SET revoked_at = ? WHERE id = ?`, store.Millis(m.Now), id); err != nil {
				return err
			}
		}
		m.Irreversible(passwordIrreversible)
		if had {
			m.Summarize("Changed the Owner password")
		} else {
			m.Summarize("Set the Owner password")
		}
		at := m.Now
		out = OwnerPassword{Set: true, SetAt: &at}
		return nil
	})
	return OwnerPasswordResult{Result: res, OwnerPassword: out}, err
}

func activeSessionIDs(ctx context.Context, tx *sql.Tx, now time.Time, except string) ([]string, error) {
	rows, err := tx.QueryContext(ctx, `SELECT id FROM owner_sessions WHERE revoked_at IS NULL AND expires_at > ? AND id != ? ORDER BY created_at`,
		store.Millis(now), except)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func (h handlers) list(c *api.Call) (any, error) {
	now := h.s.clock.Now()
	q := `SELECT ` + sessionColumns + ` FROM owner_sessions`
	var args []any
	switch c.Query("active") {
	case "":
	case "true":
		q += ` WHERE revoked_at IS NULL AND expires_at > ?`
		args = append(args, store.Millis(now))
	case "false":
		q += ` WHERE revoked_at IS NOT NULL OR expires_at <= ?`
		args = append(args, store.Millis(now))
	default:
		return nil, api.BadRequest("Use active=true, active=false, or leave it out for all sessions.", "active must be true or false.")
	}
	rows, err := h.s.db.QueryContext(c.R.Context(), q+` ORDER BY created_at DESC, rowid DESC`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := OwnerSessionList{OwnerSessions: []OwnerSession{}}
	for rows.Next() {
		x, err := scanSession(rows, now)
		if err != nil {
			return nil, err
		}
		x.Current = isCurrent(c, x.ID)
		out.OwnerSessions = append(out.OwnerSessions, x)
	}
	return out, rows.Err()
}

func (h handlers) revoke(m *audit.Mutation, ref string) (OwnerSession, error) {
	id, err := SessionResource.Resolve(m.Ctx, m.Tx, ref)
	if err != nil {
		return OwnerSession{}, err
	}
	x, err := sessionByID(m.Ctx, m.Tx, id, m.Now)
	if err != nil || x.RevokedAt != nil {
		return x, err
	}
	if err := m.Track(SessionResource, id); err != nil {
		return x, err
	}
	m.Irreversible(sessionIrreversible)
	if _, err := m.Tx.ExecContext(m.Ctx, `UPDATE owner_sessions SET revoked_at = ? WHERE id = ?`, store.Millis(m.Now), id); err != nil {
		return x, err
	}
	return sessionByID(m.Ctx, m.Tx, id, m.Now)
}
