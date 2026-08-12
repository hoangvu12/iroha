# Persist upstream key health at its actual scope

Iroha persists invalid, exhausted, disabled, and cooldown state and applies failures to a key, shared Upstream Account, connection/model pair, provider, or unknown scope. We rejected both request-local dead-key sets, which repeatedly spray known-bad credentials, and blanket key rotation, which stampedes account-wide limits; adapters improve classification while a conservative generic engine uses bounded retries and controlled cooldown recovery.

