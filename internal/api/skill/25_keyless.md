## Keyless Providers

Some services need no key and no auth header (self-hosted vLLM or Ollama, free relays). Iroha serves them with a **keyless key**: an Upstream Key with no secret. Nothing is ever sent with it, in any auth style: no auth header, no auth query parameter, and a Caller's header in the auth slot is dropped. It is an ordinary key with a Key State and Model Gaps, and it appears in key counts (`keys.keyless` in `GET /api/providers/{provider}/summary` and `GET /api/overview`).

- **One step:** give the Endpoint `"auth_style": "none"`. If the Provider holds no Upstream Keys yet, Iroha adds the keyless key `keyless` in the same change (the response's `keyless_key`; one revert removes both).
- **By hand:** `POST /api/providers/{provider}/keys` with `{"name": "keyless"}` (a name and no secret), for example on a relay whose Endpoint keeps `bearer` but ignores the header.
- A refusal of a keyless Attempt (401, 403) is `retry_elsewhere`: the key is not marked invalid, because nothing was sent to reject.
- A static header with an empty value is not sent, and drops the Caller's header of that name.
