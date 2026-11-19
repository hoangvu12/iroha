# 01: Walking skeleton: binary, SQLite, Admin Token, logs, served skill

**What to build:** A Go binary that starts on a SQLite file beside it, runs its migrations, serves liveness and readiness endpoints, and on first start prints a bootstrap Admin Token. An agent holding that token can call an authenticated admin route, read `GET /skill.md` and `GET /api/openapi.json` (both minimal but generated from the real route definitions), and read structured startup log events through the logs API. Includes the in-process HTTP test harness (temporary SQLite, injectable clock, programmable fake upstream servers) that every later ticket uses.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Binary starts with only a data directory; migrations apply on start
- [ ] Liveness and readiness routes answer
- [ ] First start creates a named Admin Token and prints it once; later starts do not
- [ ] Admin routes refuse missing or revoked tokens with a hinting error
- [ ] `/skill.md` and `/api/openapi.json` are served and cannot drift from the routes
- [ ] Startup and shutdown are logged as structured events, readable via the logs API with time and level filters
- [ ] Test harness: server in-process, fake upstreams per Shape, controllable clock
