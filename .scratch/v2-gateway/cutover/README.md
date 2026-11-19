# Cutover: v1 -> v2 on ms02 (2026-11-19)

v2 now serves `iroha.nguyenvu.dev` and `iroha-mugi.nguyenvu.dev`. v1 is still
installed and running on `127.0.0.1:3000` on ms02, untouched, as the fallback.

## What is in v2

| | |
|---|---|
| Providers | 20 (every Provider v1 had that was not archived) |
| Endpoints | 144 |
| Upstream Keys | 494 (v1 had 547 rows; 53 rows repeated a secret already on their Provider, so they were imported once) |
| Gateway Keys | 11, each with a **new** secret |
| Model lists | v1's hand-kept models restored, plus a discovery refresh for every Provider that can list its own models |

The 51 Providers v1 had **archived** (and their 63 Keys) were not imported:
v1 refused Callers on them, so they are dead weight. They stay in v1.

### Gateway Keys and their scopes

| Key | Scope |
|---|---|
| `OpenCode-All-Providers`, `HP-MEDIA`, `Chance`, `phung`, `cliproxyapi`, `studyon`, `frost`, `Test` | everything |
| `manh` | deepai, gpt, claude, dashscope, minimax |
| `Smoke-Test` | claude, gemini |
| `chayce` | minimax |

Every Gateway Key has a new secret: v1 only stored a fingerprint, so the old
secrets cannot be carried over. Read them in the Gateway Keys page or with
`GET /api/gateway-keys`.

## The carrier seed (`.scratch/v2-gateway/cutover/`)

v1 kept a per-Key list of the models that Key could serve and only asked a Key
for a model on that list. v2 has no allow-lists; it puts a Key first for a
model when that Key's own model list names it (a "carrier"). Without that
information a request for `gpt-6.2-sol` spent its whole 3-Attempt budget on
Keys that never served it.

`carriers.tsv` is v1's per-Key model lists, one `provider<TAB>base url<TAB>model`
row each. `seed_carriers.py` writes them into v2's `provider_model_sources`
under the **wire** model name (v2's Endpoint renames), which is what the planner
matches on. 271 rows for the 9 relay Providers.

    sudo systemctl stop iroha-v2
    python3 seed_carriers.py /opt/iroha-v2/iroha.db carriers.tsv
    sudo systemctl start iroha-v2

A list only reorders; it never excludes a Key (ADR-0023). Re-running it
replaces the rows it wrote.

## How the public hostname was switched

nginx serves both hostnames and proxied them to v1 on `127.0.0.1:3000`. The
switch was two `proxy_pass` lines, in `/etc/nginx/sites-available/iroha`
(the same file for both server blocks):

    proxy_pass http://127.0.0.1:3000;   ->   proxy_pass http://127.0.0.1:8080;

The old file is kept beside it as `iroha.bak-v1-<UTC stamp>`. To go back:

    sudo cp /etc/nginx/sites-available/iroha.bak-v1-<stamp> /etc/nginx/sites-available/iroha
    sudo nginx -t && sudo systemctl reload nginx

v1 needs nothing else: it is still running with its own database and its own
Gateway Keys, and it never stopped.

## What works, and what does not

Tested on 2026-11-19 with `POST /api/test` and with real Gateway Keys on
`/v1/chat/completions` and `/providers/<handle>/v1/chat/completions`:

| Provider | Result |
|---|---|
| agnes, dashscope, deepai, kimi, muse, nvidia | answer |
| gpt (gpt-6.2-sol, gpt-6-astra) | answer |
| claude (claude-opus-5.5, claude-fable-5.1) | answer |
| gemini, deepseek, grok, qwen | answer |
| minimax | **fails: 402 insufficient balance / 401 invalid api key on every key** |
| z-ai | **fails: 429 "insufficient balance or no resource package, please recharge"** |

minimax and z-ai are the Owner's account balances, not the import: v1's own
logs show the same 402 on MiniMax and the same billing refusal on Z.ai. The
Key tests say so per Key (`minimax-insufficient-balance`, `zai-plan-billing`).
They work again as soon as the accounts are topped up.

## Notes

- The import does not carry v1's runtime key health, so a key that was cooling
  or invalid in v1 starts `active` in v2 and is reclassified on its first
  Attempt. v2's Key State is then truthful: the state and the reason are shown
  together.
- v1's per-Key model allow/deny lists are not carried; the carrier seed above
  is what replaced them.
- The Import's output never prints a secret.
