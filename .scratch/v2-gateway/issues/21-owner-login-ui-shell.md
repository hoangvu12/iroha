# 21: Owner login and embedded UI shell

**What to build:** The binary serves an embedded React single-page app built to `.scratch/v2-gateway/design/v2-clean/`. The Owner sets a password on first visit, logs in (screen C13), and stays signed in for 30 days; the session acts as the Owner in Audit Entries. The shell is the sidebar from the design: Iroha banner art and avatar, a health status from the readiness endpoint, Providers / Gateway Keys / Requests / Chat with keyboard shortcuts (P, G, R, C), and the Owner row with sign out. The shell hosts the right-side chat panel slot used by ticket 23. Light and dark themes.

**Blocked by:** 02

**Status:** done

- [x] Password setup, login, logout; sessions last 30 days and can be revoked through the API
- [x] The UI build is embedded in the binary; brand art is served by Iroha
- [x] Shortcuts work from every page and are shown in the sidebar
- [x] Health status reflects readiness
- [x] Only the public admin API is used

## Comments

**Built.** `internal/session`: Owner password (PBKDF2-SHA256, 600k iterations, stdlib), sessions of a fixed 30 days from sign-in in an `iroha_session` cookie (HttpOnly, SameSite=Strict, Secure behind HTTPS; only a SHA-256 of the secret is stored), an authenticator that makes the session the actor `{kind: owner_session, name: Owner}` in Audit Entries, and routes `GET/POST/DELETE /api/session`, `PUT /api/owner-password`, `GET /api/owner-sessions`, `POST /api/owner-sessions/{session}/revoke` and `/bulk/revoke` (audited, irreversible). Changing the password signs out every other session. Ten wrong passwords in 15 minutes lock sign-in (429, Retry-After); the lock is global because client addresses behind a proxy can be forged, and Admin Tokens still work. A changing call with the cookie and `Sec-Fetch-Site: cross-site` is refused (403). `internal/webui` serves the embedded build and the brand art (`/brand/iroha-sidebar-banner.jpg`, `/brand/iroha-avatar.png`, copied from v1); browser page loads of unknown paths get `index.html`, everything else keeps the JSON 404 (`api.Router.Fallback`). `/healthz` and `/readyz` now say `"ui": true|false`. The frontend (React, Vite, Tailwind, React Router, TanStack Query, Radix, Sonner) and its structure are documented in `docs/agents/architecture.md` ("Frontend"); `/states` in the UI shows every shared component (C25). Verified in headless Chrome: setup with a wrong and a right Admin Token, shell in light and dark, shortcuts P/G/R/C, chat sheet, Owner menu, toasts, revoke dialog, phone tab bar and full-page chat, sign out and sign back in, and other tabs holding the signed-out session falling back to the login on reload.

**Decisions.**
- *First-visit setup needs an Admin Token.* `PUT /api/owner-password` is an admin route; the setup screen asks for the bootstrap Admin Token printed on first start. Otherwise whoever reached a freshly deployed Iroha first could claim it. Agents can also set or reset the password with their token (no `current_password` needed); a session must send `current_password`.
- *Last Admin Token guard (ticket 02).* Kept, but it now applies only while no Owner password is set: once the Owner can sign in, revoking the last active Admin Token cannot lock everyone out (the Owner signs in and creates a new one), so it is allowed. Without a password it is refused as before.
- *Sessions are fixed 30 days, not sliding.* Signing in and out are log events (`owner.login`, `owner.login_failed`, `owner.logout`), not Audit Entries; they do not change configuration. Revoking a session through the API and setting the password are Audit Entries, both irreversible.
- *Health and avatar.* The design README removed the brand/status row, while this ticket asks for avatar and health. Compromise: the avatar sits in the Owner row with a small health dot (green ready, red not ready, grey checking); when Iroha is not ready or not answering, a red notice with the failed call appears above Settings. On phones the dot is on the header avatar that opens Settings (C30).
- *The UI build is not committed.* Only `internal/webui/dist/.gitkeep` is; a Go-only build serves a page saying the UI was not built. Release builds must run `npm --prefix web ci && npm --prefix web run build` before `go build` (for ticket 03: also check `"ui": true` on `/healthz` before switching over). I did not edit `deploy/`.
- *Theme.* Follows the system; the Owner row menu overrides it (System / Light / Dark), kept in the browser.

**Deferred.** Changing the password and listing sessions in the UI (the API exists; ticket 28's Settings page is the natural home). The login art is the 728x546 v1 banner scaled up, as the design README notes; a larger original would look sharper.
