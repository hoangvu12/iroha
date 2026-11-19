# 11: Model metadata for clients

**What to build:** Every listed model carries context window, max input, max output, modalities, reasoning support and levels, and `chat:"ok"` unless known not to chat. Facts come from Owner overrides, then the Provider's own list (normalising common field aliases and nested shapes), then models.dev (exact, dot-versus-dash, bare name with a single numbered release; looked up by the Provider's models.dev brand; cached; failure leaves fields blank). Metadata never affects listing or routing.

**Blocked by:** 10

**Status:** done

- [x] Precedence covered by table tests of the metadata module
- [x] No fuzzy prefix matching; ambiguous matches leave fields blank
- [x] Owner overrides through the API
- [x] A models.dev outage never fails discovery

## Comments

Built `internal/modelmeta` (pure, table-tested: `Facts`, `Normalize`, `Catalog.Lookup`, `Resolve`, `Served`; plus `Source`, the models.dev reader with a 15 min cache, single flight, ETag revalidation, mirror fallback, 1 min wait after a failure). Providers gained `models_dev_brand` (audited; "" = none, then only models.dev's maker catalog by name). Entries gained `overrides` (Owner, set with `metadata` on `POST /api/providers/{provider}/models`, audited and revertible, keeps the entry), and `external`/`external_brand` (models.dev facts, looked up after each refresh, skipped ones included, and right after Owner changes). `GET /providers/{handle}/v1/models` entries now carry `context_length`, `max_input_tokens`, `max_output_tokens`, `architecture.{input,output}_modalities`, `reasoning`, `reasoning_levels` and `chat` (field names kept from v1's list so Pi and OpenCode setups carry over); `models.CallerModel` and `Store.Metadata` are the pieces ticket 12 should reuse. The admin list shows `metadata` and each layer. models.dev is read from `--models-dev` (default models.dev, then its GitHub mirror; `none` turns it off; tests default to off and use `testkit.NewModelsDev`).

Decisions worth knowing: with a brand, the brand's api.json entry wins and models.json fills blanks; without one, only models.json (makers' first-party facts, no reseller limits). A `supported_endpoints` list naming `responses` or `messages` counts as chat (Iroha translates). OpenRouter-style routing suffixes (`:free`, `:thinking`...) are ignored for lookups. Changing the brand blanks models.dev facts until the next refresh (no lookup is run by the Provider routes). Display names (v1 `normalized_name`) are not carried.
