# Z.ai (Zhipu / BigModel) Provider

Status: Complete

## Problem

Z.ai is Zhipu AI's international surface for the GLM model family. The Owner asked for Z.ai (and the mainland-China BigModel brand) as a typed Provider so a self-hosted Iroha can route GLM Coding Plan traffic through one Gateway Key. Z.ai exposes an OpenAI-compatible Chat Completions surface at `https://api.z.ai/api/coding/paas/v4` (the BigModel equivalent lives at `https://open.bigmodel.cn/api/coding/paas/v4`) with a typed error envelope that distinguishes exhaustion, throttling, plan expiry, and content-policy rejection — none of which a generic Inference Adapter can normalize usefully.

## Goal

Make Z.ai a first-class Provider with typed capacity-aware failure classification, brand identity, known model coverage, and authoritative GLM Coding Plan quota. The Owner may override the base URL to the BigModel endpoint without losing typed inference or usage behavior. Pay-as-you-go credit remains unknown because no key-authenticated balance endpoint is available.

## Decisions

- One Provider Template (`zai`) backs both Z.ai and the BigModel URL. The Owner overrides `baseUrl` when the account is on `open.bigmodel.cn`; the typed adapter stays the same because both surfaces share the documented Z.ai error envelope.
- A typed Z.ai Inference Adapter classifies the documented error codes (`docs.z.ai/api-reference/api-code.md`) instead of falling back to generic HTTP status. The codes are documented:
  - `1000`/`1001`/`1003`/`1005` → HTTP 401 (authentication)
  - `1113` → HTTP 429 "Insufficient balance or no resource package"
  - `1301` → HTTP 400 content-policy rejection
  - `1302` → HTTP 429 transient rate limit
  - `1305` → HTTP 429 Provider/model overload
  - `1308` → HTTP 429 5-hour usage limit reached, body carries `next_flush_time`
  - `1309` → HTTP 429 plan expired
  - `1310` → HTTP 429 weekly/monthly limit exhausted, body carries `next_flush_time`
  - `1311` → HTTP 429 plan does not include the requested model
  - `1313` → HTTP 429 fair-use policy throttling
  - `1314` → HTTP 429 enterprise plan expired
  - `1315` → HTTP 429 key belongs to the wrong product surface
  - `1316`–`1321` → HTTP 429 5h/7d window exhaustion, body carries `next_flush_time`
- `next_flush_time` may arrive as an ISO string or a Unix-millisecond number; the adapter accepts both and emits it as `recheckAt` for the structured 1308/1310/1316–1321 cases.
- 1113, 1309, and the unset-`next_flush_time` 1316–1321 variants map to key-scoped exhaustion with no provider reset time. The reconciliation module already treats a `null` `recheckAt` from an authoritative-looking reading as an indefinite exhaustion, and falls back to a bounded safety poll.
- 1302 (transient rate limit) maps to `temporarily_limited` key-scoped capacity with a 60-second evidence freshness floor, mirroring the MiniMax 429 classification.
- The adapter is otherwise OpenAI-shaped: chat completions stream verbatim, the `reasoning_content` field is preserved (Z.ai emits it for GLM-4.5+), and the generic `<think>…</think>` extraction in the generic adapter still applies for the GLM-4.5V series.
- `response_format` accepts `text` and `json_object` but not `json_schema`, so `structuredOutput` is `false` on the template. The Owner can override per model if they verify support.
- The OpenAI Responses API surface is not documented for the `/api/coding/paas/v4` base URL, so `responses` is `false`. The Anthropic-shaped surface (`/api/anthropic`) is an Owner-set alternate base URL, not a typed adapter.
- Known models: `glm-5.3`, `glm-5-turbo`, `glm-4.7`, `glm-5.2`, `glm-5.1`, `glm-5`, `glm-4.6`, `glm-4.5`, `glm-4.5-air`. The coding-plan trio (5.3, 5-Turbo, 4.7) is the curated subset the platform advertises as the supported plan tier.
- Brand identity uses `z.ai` as the logo.dev domain and a teal accent (`#0EA5E9`) consistent with the public site's UI. The Owner UI's fallback favicon service covers the domain if logo.dev has no entry yet.
- A typed Usage Adapter calls `GET /api/monitor/usage/quota/limit` on the regional host selected from the Provider base URL. A `code: 200` response with `data.limits[]` yields authoritative per-key GLM Coding Plan percentage, counts, and reset time. A valid pay-as-you-go key with no Coding Plan yields no reading; Iroha does not present that as zero credit.

## Z.ai behavior

### Failure classification

| HTTP | code(s) | Failure kind | Capacity scope | Retry |
| --- | --- | --- | --- | --- |
| 400 | 1211, 1212, 1213, 1214, 1215, 1221, 1222, 1261, 1301 | `request_rejected` | unknown | `stop` |
| 400 | other | `request_rejected` (generic) | unknown | `stop` |
| 401 | 1000, 1001, 1003, 1005 | `authentication_invalid` | key | `try_alternate` |
| 403 | 1220 | `authentication_rejected` | key | `try_alternate` |
| 429 | 1113 | `payment_required` | key | `try_alternate` |
| 429 | 1302 | `capacity_limited` | key | `try_alternate` (provisional) |
| 429 | 1308, 1310, 1316, 1317, 1318, 1319, 1320, 1321 | `capacity_limited` | key | `try_alternate` (provisional, with `recheckAt` from `next_flush_time`) |
| 429 | 1309 | `payment_required` | key | `try_alternate` |
| 429 | 1311 | `request_rejected` | connection_model | `stop` (plan doesn't include the requested model — retrying won't help) |
| 429 | 1313 | `capacity_limited` | key | `try_alternate` (provisional) |
| 429 | other | generic `capacity_limited` | unknown | `try_alternate` |
| 5xx | any | `provider_failure` | connection_model | `retry_same` |

The adapter is conservative when the body is not a recognized shape: it falls through to the generic classification (status-based, scope `unknown`, no capacity evidence).

### Manual Refresh

The Owner Refresh action probes authentication and polls the regional coding-plan quota endpoint. Confirmed positive quota may restore Routing Eligibility; confirmed zero quota exhausts the affected Upstream Key. A successful model probe alone does not clear exhaustion.

### Recovery

Exhausted Z.ai keys do not rejoin round-robin until either a fresh inference returns 2xx or the advertised `next_flush_time` elapses plus a bounded safety jitter. The reconciliation module polls again after the advertised boundary so a key whose window has rolled over re-enters selection without an Owner action.

## Verification

- Unit tests cover every documented error code, `next_flush_time` ISO and Unix-ms shapes, the bare-body fall-through, generic-status fall-through, and the OpenAI-shaped success pass-through.
- Adapter registry tests assert the typed adapter id is registered and the `zai` template references it.
- Template tests assert the Z.ai template's base URL, auth shape, capability claims, known-model list, brand identity, and usage adapter honesty.
- Assembled HTTP tests verify the Owner can create a Z.ai Provider, run inference against a mocked `/chat/completions`, and observe the structured 1113 and 1308 classifications on retry. These reuse the existing generic-transport infrastructure; the typed adapter wires into the registry.

## Out of scope

- GLM-Image, GLM-Vision, CogVideoX, ASR, layout-parsing, web search, and reader endpoints. They are documented but outside Iroha's version-one surface (chat completions only).
- Web Reader / Web Search MCP integration from the coding plan. Those are tool-callable features, not entitlement.
- The Anthropic-shaped surface (`/api/anthropic`). The Owner may set it as `baseUrl` and the generic Inference Adapter's Anthropic translate path remains honest about that surface being a separate feature.
- Storing raw Provider response bodies or arbitrary upstream messages.

## Research evidence

- The public OpenAPI spec does not list the console-backed quota endpoint, but `../nyanis` live-verifies `GET /api/monitor/usage/quota/limit` with Bearer authentication on both `api.z.ai` and `open.bigmodel.cn`.
- No working pay-as-you-go balance endpoint was found; `/api/paas/v4/account/balance` returns 404, so credit remains unknown.
- Per-request `usage` objects (`prompt_tokens`, `completion_tokens`, `total_tokens`, `prompt_tokens_details.cached_tokens`) are real-time token accounting, not entitlement.
- The only documented entitlement surface is the web console (`https://z.ai/manage-apikey/subscription`, `https://z.ai/manage-apikey/coding-plan/personal/my-plan`).
- Error-code documentation at `https://docs.z.ai/api-reference/api-code.md` is the source of truth for the structured 429 classification.
