package session_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/session"
	"github.com/hoangvu12/iroha/internal/testkit"
)

type status = session.SessionStatus

func signIn(t *testing.T, srv *testkit.Server, password string) (*testkit.Client, status) {
	t.Helper()
	var st status
	r := srv.Anon.Post("/api/session", map[string]any{"password": password}).Expect(201).JSON(&st)
	ck := r.Cookie(session.CookieName)
	if ck == nil {
		t.Fatalf("no session cookie; headers %v", r.Header)
	}
	return srv.Anon.WithCookie(ck), st
}

func TestTheOwnerSetsAPasswordOnFirstVisitThenSignsInFor30Days(t *testing.T) {
	srv := testkit.Start(t)

	var st status
	srv.Anon.Get("/api/session").Expect(200).JSON(&st)
	if st.PasswordSet || st.SignedIn || st.Session != nil {
		t.Fatalf("fresh install: %+v", st)
	}
	if e := srv.Anon.Post("/api/session", map[string]any{"password": "whatever-123"}).Expect(409).Err(); e.Code != "owner_password_not_set" || !strings.Contains(e.Hint, "PUT /api/owner-password") {
		t.Fatalf("sign-in before setup: %+v", e)
	}
	// Setting the password needs an Admin Token, so whoever reaches a new
	// Iroha first cannot claim it.
	if e := srv.Anon.Put("/api/owner-password", map[string]any{"password": "correct horse"}).Expect(401).Err(); e.Code != "admin_token_missing" {
		t.Fatalf("anonymous setup: %+v", e)
	}
	if e := srv.Admin.Put("/api/owner-password", map[string]any{"password": "short"}).Expect(400).Err(); e.Hint == "" {
		t.Fatalf("short password: %+v", e)
	}
	var set session.OwnerPasswordResult
	srv.Admin.Put("/api/owner-password", map[string]any{"password": "correct horse"}).Expect(201).JSON(&set)
	if !set.OwnerPassword.Set || set.Outcome != "created" || set.AuditEntry == "" {
		t.Fatalf("setup = %+v", set)
	}
	if strings.Contains(string(set.Changes[0].After), "pbkdf2") {
		t.Fatalf("the change shows the password hash: %s", set.Changes[0].After)
	}

	if e := srv.Anon.Post("/api/session", map[string]any{"password": "wrong horse"}).Expect(401).Err(); e.Code != "owner_password_wrong" || e.Hint == "" {
		t.Fatalf("wrong password: %+v", e)
	}
	r := srv.Anon.WithHeader("User-Agent", "TestBrowser/1.0").Post("/api/session", map[string]any{"password": "correct horse"}).Expect(201)
	ck := r.Cookie(session.CookieName)
	if ck == nil || !ck.HttpOnly || ck.SameSite != http.SameSiteStrictMode || ck.Path != "/" || ck.MaxAge != 30*24*3600 {
		t.Fatalf("session cookie = %+v", ck)
	}
	owner := srv.Anon.WithCookie(ck)
	owner.Get("/api/session").Expect(200).JSON(&st)
	if !st.PasswordSet || !st.SignedIn || st.Session == nil || !st.Session.Current || st.Session.UserAgent != "TestBrowser/1.0" ||
		!st.Session.ExpiresAt.Equal(testkit.Epoch.Add(30*24*time.Hour)) {
		t.Fatalf("signed-in status = %+v", st)
	}
	var who api.Actor
	owner.Get("/api/whoami").Expect(200).JSON(&who)
	if who.Kind != api.ActorOwnerSession || who.Name != "Owner" || who.ID != st.Session.ID {
		t.Fatalf("whoami = %+v", who)
	}
	if n := len(srv.Logs("kind=owner.login")); n != 1 {
		t.Fatalf("login events = %d", n)
	}
	if n := len(srv.Logs("kind=owner.login_failed")); n != 1 {
		t.Fatalf("failed login events = %d", n)
	}
	for _, line := range testkit.Lines(srv.Console()) {
		if strings.Contains(line, ck.Value) || strings.Contains(line, "correct horse") {
			t.Fatalf("a secret leaked into the console: %s", line)
		}
	}

	// The session survives a restart and lasts exactly 30 days.
	srv.Restart()
	srv.Clock.Advance(30*24*time.Hour - time.Second)
	owner.Get("/api/whoami").Expect(200)
	srv.Clock.Advance(time.Second)
	if e := owner.Get("/api/whoami").Expect(401).Err(); e.Code != "owner_session_expired" || e.Hint == "" {
		t.Fatalf("expired session: %+v", e)
	}
	owner.Get("/api/session").Expect(200).JSON(&st)
	if st.SignedIn || !st.PasswordSet {
		t.Fatalf("status after expiry = %+v", st)
	}
	if e := srv.Anon.WithCookie(&http.Cookie{Name: session.CookieName, Value: "iroha_session_forged"}).Get("/api/whoami").Expect(401).Err(); e.Code != "owner_session_invalid" {
		t.Fatalf("unknown session: %+v", e)
	}
}

func TestTheSessionActsAsTheOwnerInAuditEntries(t *testing.T) {
	srv := testkit.Start(t)
	owner := srv.OwnerSession()

	var created struct {
		AuditEntry string `json:"audit_entry"`
	}
	owner.Post("/api/admin-tokens", map[string]any{"name": "agent-1"}).Expect(201).JSON(&created)
	var entry audit.Entry
	srv.Admin.Get("/api/audit-entries/" + created.AuditEntry).Expect(200).JSON(&entry)
	if entry.Actor.Kind != api.ActorOwnerSession || entry.Actor.Name != "Owner" {
		t.Fatalf("actor = %+v", entry.Actor)
	}
	var page audit.EntryPage
	srv.Admin.Get("/api/audit-entries?actor=Owner").Expect(200).JSON(&page)
	if len(page.Entries) != 1 || page.Entries[0].ID != created.AuditEntry {
		t.Fatalf("actor=Owner: %+v", page.Entries)
	}
	// The Owner reverts it like an agent would.
	owner.Post("/api/audit-entries/"+created.AuditEntry+"/revert", nil).Expect(200)
	srv.Admin.Get("/api/admin-tokens/agent-1").Expect(404)
}

func TestSessionsAreListedAndRevokedThroughTheAPI(t *testing.T) {
	srv := testkit.Start(t)
	laptop := srv.OwnerSession()
	srv.Clock.Advance(time.Minute)
	phone, phoneStatus := signIn(t, srv, testkit.OwnerPassword)

	var list session.OwnerSessionList
	phone.Get("/api/owner-sessions").Expect(200).JSON(&list)
	if len(list.OwnerSessions) != 2 || list.OwnerSessions[0].ID != phoneStatus.Session.ID || !list.OwnerSessions[0].Current || list.OwnerSessions[1].Current {
		t.Fatalf("sessions as seen from the phone = %+v", list)
	}

	// An agent revokes the phone's session: irreversible, audited.
	var res session.OwnerSessionResult
	srv.Admin.Post("/api/owner-sessions/"+phoneStatus.Session.ID+"/revoke", nil).Expect(200).JSON(&res)
	if res.Outcome != "updated" || res.OwnerSession.Active || res.AuditEntry == "" {
		t.Fatalf("revoke = %+v", res)
	}
	if e := phone.Get("/api/whoami").Expect(401).Err(); e.Code != "owner_session_revoked" {
		t.Fatalf("revoked session: %+v", e)
	}
	laptop.Get("/api/whoami").Expect(200)
	if e := srv.Admin.Post("/api/audit-entries/"+res.AuditEntry+"/revert", nil).Expect(409).Err(); e.Code != "audit_irreversible" {
		t.Fatalf("revert of a revoke: %+v", e)
	}
	srv.Admin.Get("/api/owner-sessions?active=true").Expect(200).JSON(&list)
	if len(list.OwnerSessions) != 1 {
		t.Fatalf("active sessions = %+v", list)
	}

	// Sign out ends the session and deletes the cookie.
	r := laptop.Delete("/api/session").Expect(204)
	if ck := r.Cookie(session.CookieName); ck == nil || ck.MaxAge >= 0 {
		t.Fatalf("sign-out cookie = %+v", ck)
	}
	laptop.Get("/api/whoami").Expect(401)
	srv.Anon.Delete("/api/session").Expect(204) // without a session too
	if n := len(srv.Logs("kind=owner.logout")); n != 1 {
		t.Fatalf("logout events = %d", n)
	}

	// Bulk revoke.
	a, sa := signIn(t, srv, testkit.OwnerPassword)
	_, sb := signIn(t, srv, testkit.OwnerPassword)
	var bulk audit.BulkResult[session.OwnerSession]
	srv.Admin.Post("/api/owner-sessions/bulk/revoke", map[string]any{"items": []string{sa.Session.ID, "os_nope", sb.Session.ID}}).Expect(200).JSON(&bulk)
	if bulk.Succeeded != 2 || bulk.Failed != 1 || bulk.Items[1].Error.Code != "not_found" {
		t.Fatalf("bulk revoke = %+v", bulk)
	}
	a.Get("/api/whoami").Expect(401)
}

func TestChangingThePasswordSignsOutEveryOtherSession(t *testing.T) {
	srv := testkit.Start(t)
	laptop := srv.OwnerSession()
	phone, _ := signIn(t, srv, testkit.OwnerPassword)

	if e := laptop.Put("/api/owner-password", map[string]any{"password": "a new password"}).Expect(400).Err(); !strings.Contains(e.Message, "current_password") {
		t.Fatalf("change without current_password: %+v", e)
	}
	if e := laptop.Put("/api/owner-password", map[string]any{"password": "a new password", "current_password": "nope-nope"}).Expect(403).Err(); e.Code != "owner_password_wrong" {
		t.Fatalf("change with a wrong current_password: %+v", e)
	}
	var dry session.OwnerPasswordResult
	laptop.Put("/api/owner-password?dry_run=true", map[string]any{"password": "a new password", "current_password": testkit.OwnerPassword}).Expect(200).JSON(&dry)
	if !dry.DryRun || len(dry.Changes) != 2 {
		t.Fatalf("dry run = %+v", dry)
	}
	phone.Get("/api/whoami").Expect(200)

	var res session.OwnerPasswordResult
	laptop.Put("/api/owner-password", map[string]any{"password": "a new password", "current_password": testkit.OwnerPassword}).Expect(200).JSON(&res)
	if res.Outcome != "updated" || len(res.Changes) != 2 || res.Changes[1].Resource != "owner_session" {
		t.Fatalf("change = %+v", res)
	}
	laptop.Get("/api/whoami").Expect(200)
	phone.Get("/api/whoami").Expect(401)
	srv.Anon.Post("/api/session", map[string]any{"password": testkit.OwnerPassword}).Expect(401)
	signIn(t, srv, "a new password")

	var entry audit.Entry
	srv.Admin.Get("/api/audit-entries/" + res.AuditEntry).Expect(200).JSON(&entry)
	if entry.Summary != "Changed the Owner password" || entry.Revertible {
		t.Fatalf("entry = %+v", entry)
	}
	// An Admin Token resets it without the old one and signs out everyone.
	srv.Admin.Put("/api/owner-password", map[string]any{"password": "reset by an agent"}).Expect(200)
	laptop.Get("/api/whoami").Expect(401)
}

func TestManyWrongPasswordsLockSignInForAWhile(t *testing.T) {
	srv := testkit.Start(t)
	srv.OwnerSession()
	for i := 0; i < 10; i++ {
		srv.Anon.Post("/api/session", map[string]any{"password": "guess-" + string(rune('a'+i))}).Expect(401)
	}
	r := srv.Anon.Post("/api/session", map[string]any{"password": testkit.OwnerPassword}).Expect(429)
	if r.Header.Get("Retry-After") != "900" || r.Err().Code != "too_many_attempts" {
		t.Fatalf("locked sign-in: %s %s", r.Header.Get("Retry-After"), r.Body)
	}
	srv.Clock.Advance(15 * time.Minute)
	signIn(t, srv, testkit.OwnerPassword)
}

func TestAnotherSiteCannotChangeIrohaWithTheOwnersCookie(t *testing.T) {
	srv := testkit.Start(t)
	owner := srv.OwnerSession()
	cross := owner.WithHeader("Sec-Fetch-Site", "cross-site")
	if e := cross.Post("/api/admin-tokens", map[string]any{"name": "evil"}).Expect(403).Err(); e.Code != "cross_site_request" {
		t.Fatalf("cross-site change: %+v", e)
	}
	cross.Get("/api/whoami").Expect(200) // reads are harmless
	owner.WithHeader("Sec-Fetch-Site", "same-origin").Post("/api/admin-tokens", map[string]any{"name": "fine"}).Expect(201)
}
