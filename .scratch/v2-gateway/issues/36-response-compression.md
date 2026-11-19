# 36: Response compression

**What to build:** v2 never compresses answers (catalog REQ-105, RUN-08: v1 gzipped JSON ≥ 1 KiB). Behind Cloudflare this rarely matters, but `/v1/models` (thousands of entries) and `/api/requests` are large on direct connections. Either add gzip for JSON at or above 1 KiB when `Accept-Encoding: gzip` (never `text/event-stream`, HEAD, 204, 304; `Vary: Accept-Encoding`), in one place in `internal/api` and the gateway's buffered relay, or record "Cloudflare compresses at the edge" as the answer and close this.

**Blocked by:** none

**Status:** closed (won't do)

- [ ] If built: a test per rule above through the HTTP seam; streams stay uncompressed and flushed per event

## Comments

- Closed by the Owner (2026-11-19): Cloudflare compresses at the edge.
