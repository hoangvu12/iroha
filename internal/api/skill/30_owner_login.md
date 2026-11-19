## The Owner's login

The Owner uses the web UI (served at `/` by Iroha itself) with a password; agents use Admin Tokens. The UI calls only the admin API described here, with a session cookie instead of a bearer token, so anything the Owner can do in the UI you can do with your token.

- `GET /api/session` says whether an Owner password is set. Until it is, nobody can sign in to the UI. On a new install, set it with `PUT /api/owner-password` and `{"password": "..."}` (at least 8 characters) using your Admin Token, or let the Owner do it on the UI's first visit (the form asks for an Admin Token, so whoever reaches a new Iroha first cannot claim it).
- A sign-in lasts 30 days. In Audit Entries the Owner's changes show `"actor": {"kind": "owner_session", "name": "Owner"}`; filter with `actor=Owner`.
- `GET /api/owner-sessions` lists sessions; `POST /api/owner-sessions/{id}/revoke` signs one out (irreversible). Changing the password signs out every other session.
- If the Owner is locked out, reset the password with `PUT /api/owner-password`; an Admin Token needs no `current_password`.
- The last active Admin Token can be revoked only while an Owner password is set, because the Owner can then sign in and create a new one.
- `GET /healthz` reports `"ui": false` when the binary was built without its UI.
