## Gateway Keys: activity, revoke or delete

- **Activity**: every Gateway Key in `GET /api/gateway-keys` (and `GET /api/gateway-keys/<name>`) carries `last_used_at` (to the minute) and `recent_requests`, its own Requests of the last 24 hours. Test chats sent as the key are not counted; list the Requests themselves with `GET /api/requests?caller=<name>&since=24h`.
- **Revoke or delete**: `POST /api/gateway-keys/<name>/revoke` cuts the Caller off for good and keeps the key and its name on record (cannot be reverted). `DELETE /api/gateway-keys/<name>` removes the key and frees its name; its Audit Entry reverts it, bringing back the same secret, scope and capture setting. Requests already recorded keep the key's name either way.
