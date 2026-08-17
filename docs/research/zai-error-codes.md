# Z.ai / BigModel inference error and status semantics

Research date: 2026-08-17

Scope: current first-party Z.ai and BigModel documentation relevant to Iroha's Inference Adapter. This note intentionally does not use observed credentials or include raw credential-bearing responses.

## Documented response contract

Z.ai describes two layers of failure information: an outer HTTP status and an inner business error code. Non-streaming errors are documented as JSON with a top-level `error` object containing string-valued `code` and a human-readable `message`:

```json
{
  "error": {
    "code": "1214",
    "message": "Parameter `${field}` is invalid. Please check the documentation."
  }
}
```

The current page says errors are always returned in that shape and its wire example also represents the code as a string. It does **not** document `type`, `upstream_code`, `upstream_type`, a structured request/error ID, or a `Retry-After` response header. [Z.ai Errors](https://docs.z.ai/api-reference/api-code)

The global and mainland documentation publish the same current table. The mainland wording adds useful distinctions for codes 1318-1321 described below. [BigModel error codes](https://docs.bigmodel.cn/cn/api/api-code)

## Current documented code table

| Business code | HTTP | Documented meaning | Inference-handling meaning |
|---|---:|---|---|
| none | 500 | Internal error | Transient Provider failure; bounded retry is reasonable. |
| 1000 | 401 | Authentication failed | Invalid/inconclusive credential evidence; do not treat as Capacity Evidence. |
| 1001 | 401 | Authentication parameter missing from header | Authentication/request construction failure; retrying unchanged cannot help. |
| 1003 | 401 | Authentication token expired | Credential failure; Owner refresh/replacement is required. |
| 1005 | 401 | Two-factor authentication required | Authentication/account intervention; retrying unchanged cannot help. |
| 1113 | 429 | Insufficient balance **or no resource package** | Billing/entitlement stop. The code is intrinsically ambiguous and does not prove a numeric balance of zero. |
| 1200 | 500 | API call failed | Provider failure; bounded retry is reasonable. |
| 1210 | 400 | Invalid API parameter | Request rejected; stop. |
| 1211 | 400 | Unknown model | Provider/model request rejected; stop or select a valid model. |
| 1212 | 400 | Model does not support the requested method | Provider/model capability mismatch; stop. |
| 1213 | 400 | Required field not received | Request rejected; stop. |
| 1214 | 400 | Invalid field | Request rejected; stop. |
| 1215 | 400 | Mutually exclusive fields supplied | Request rejected; stop. |
| 1220 | 403 | No permission for the API | Access/entitlement failure. The docs do not distinguish credential-wide from API-specific permission. |
| 1221 | 400 | API taken offline | Provider/API capability failure; unchanged retry is not useful. |
| 1222 | 400 | API does not exist | Provider/API request rejected; stop. |
| 1230 | 500 | API call process error | Provider failure; bounded retry is reasonable. |
| 1234 | 500 | Network error, with an error ID in the message | Transient Provider failure; bounded retry is reasonable. The error ID has no documented structured field. |
| 1261 | 400 | Prompt too long | Request/model-context rejection; stop or reduce input. |
| 1301 | 400 | Unsafe or sensitive input or generation | Per-request policy rejection; stop and do not demote the Upstream Key. |
| 1302 | 429 | Request/account rate limit reached | Temporary throttling; bounded backoff/retry. The affected Capacity Scope is not documented. |
| 1305 | 429 | Service/model temporarily overloaded | Transient Provider/model overload; alternate-key rotation is not established to help. |
| 1308 | 429 | Usage limit for a documented number/unit; reset at `next_flush_time` | Temporary usage exhaustion; wait for the reset if it can be safely extracted. |
| 1309 | 429 | GLM Coding Plan expired | Durable subscription/entitlement stop until renewed. |
| 1310 | 429 | Weekly/monthly limit exhausted; reset at `next_flush_time` | Temporary usage exhaustion. The code alone does not identify weekly versus monthly. |
| 1311 | 429 | Subscription does not include the requested model | Provider/model entitlement rejection; retrying another key is only useful if that key has a different entitlement. |
| 1313 | 429 | Fair Usage Policy restriction | Account/credential intervention is required; docs say restoration requires submitting a request. No reset time is promised. |
| 1314 | 429 | Enterprise package expired | Durable enterprise entitlement stop until an administrator resolves it. |
| 1315 | 429 | API key is restricted to enterprise coding scenarios / wrong product-type key | Credential-endpoint/product mismatch; stop and replace the key or endpoint configuration. |
| 1316 | 429 | Past-five-hour limit; insufficient balance for paid overage; reset time | Temporary five-hour exhaustion with no paid overage. |
| 1317 | 429 | Past-seven-day limit; insufficient balance for paid overage; reset time | Temporary seven-day exhaustion with no paid overage. |
| 1318 | 429 | Past-five-hour limit; sub-account monthly spend cap blocks overage; reset time | Temporary five-hour exhaustion; administrative spend cap also applies. |
| 1319 | 429 | Past-seven-day limit; sub-account monthly spend cap blocks overage; reset time | Temporary seven-day exhaustion; administrative spend cap also applies. |
| 1320 | 429 | Past-five-hour limit; enterprise monthly spend cap blocks overage; reset time | Temporary five-hour exhaustion; enterprise spend cap also applies. |
| 1321 | 429 | Past-seven-day limit; enterprise monthly spend cap blocks overage; reset time | Temporary seven-day exhaustion; enterprise spend cap also applies. |

Sources: [Z.ai Errors](https://docs.z.ai/api-reference/api-code), [BigModel error codes](https://docs.bigmodel.cn/cn/api/api-code).

The global English page renders 1318/1320 and 1319/1321 with duplicate wording. The mainland first-party page distinguishes sub-account monthly caps (1318/1319) from enterprise monthly caps (1320/1321). That distinction is useful diagnostics, but all four remain temporary window exhaustion plus a separately unresolved administrative cap.

### Additional codes in the official BigModel catalog

BigModel also maintains an older/broader first-party error catalog whose contents are not synchronized with the current compact Z.ai table. It additionally lists:

| Code | Documented meaning | Handling implication |
|---|---|---|
| 1002 | Invalid authentication token | Credential rejection; stop and refresh/replace. |
| 1004 | Authentication failed for supplied token | Credential rejection; stop and refresh/replace. |
| 1100 | Account read/write error | Ambiguous account failure; do not assert capacity from the code alone. |
| 1110 | Account inactive | Account intervention; unchanged retry is not useful. |
| 1111 | Account does not exist | Credential/account rejection. |
| 1112 | Account locked | Account intervention. |
| 1120 | Unable to access account; try later | Transient account service failure. |
| 1121 | Irregular activity; account locked | Account/policy intervention. |
| 1231 | Duplicate request ID / request already exists | Request-id conflict; generate a new unique ID only if replay semantics allow. |
| 1300 | API call blocked by policy | Per-request or policy rejection; the catalog does not define scope. |
| 1304 | Daily API call limit reached | Capacity exhaustion with an undocumented reset time/scope. |

That catalog also describes outer HTTP 404 cases for unavailable/missing fine-tuning features/tasks, HTTP 434 for beta API permission, and HTTP 435 for files over 100 MB. These are less relevant to chat inference but reinforce that the error universe is not limited to the compact global table. [BigModel broader error catalog](https://docs.bigmodel.cn/cn/faq/api-code)

For Iroha, the safe compatibility posture is to normalize numeric or string codes to bounded strings, recognize the union where semantics are clear, and preserve unknown-code diagnostics plus generic HTTP fallback.

## Streaming failures are a separate path

The error page explicitly warns that when an SSE inference terminates abnormally after streaming has begun, the normal HTTP/business-code envelope is not returned. The failure reason instead appears in `choices[].finish_reason`. [Z.ai Errors](https://docs.z.ai/api-reference/api-code)

Chat Completions currently documents these `finish_reason` values: `stop`, `tool_calls`, `length`, `sensitive`, `model_context_window_exceeded`, and `network_error`. [Z.ai Chat Completion](https://docs.z.ai/api-reference/llm/chat-completion)

Reasonable Iroha interpretations, clearly marked as inference rather than an official retry matrix:

- `sensitive`: terminal per-request policy rejection.
- `length`: successful/partial generation stopped at output length, not key failure.
- `model_context_window_exceeded`: terminal request/model-context rejection.
- `network_error`: transient upstream/transport failure; retry safety depends on whether output was already delivered to the caller.
- `stop` and `tool_calls`: normal completion states.

Therefore, classifying only buffered non-2xx bodies cannot cover documented mid-stream failures.

## Comparison with `src/inference/zai-adapter.ts`

The adapter already handles the most important subscription codes: 1113, 1301, 1302, 1308-1311, 1313, and 1316-1321. Its bounded parser is appropriately conservative and its generic HTTP fallback preserves unknown codes.

Documented gaps worth handling explicitly:

1. **1305 overload** is currently only generic HTTP 429. It should be distinguished from durable Capacity Evidence: the docs call it temporary service/model overload.
2. **1314 enterprise package expired** is currently generic 429. It is a durable entitlement stop, analogous to 1309 but enterprise-admin resolved.
3. **1315 wrong product-type key** is currently generic 429. It is a credential/configuration mismatch, not temporary capacity.
4. Authentication codes 1000, 1001, 1003, and 1005 and permission code 1220 are captured in diagnostics through generic status behavior, but explicit code interpretation could make Retry Action and diagnostics more precise.
5. Request codes 1210-1215, 1221-1222, 1261 and Provider failures 1200, 1230, 1234 can be classified more precisely than HTTP alone.
6. The adapter's comments say the body carries `next_flush_time`, and `parseRecheckTime` looks for `error.next_flush_time`. The official error contract only guarantees `error.code` and `error.message`; reset placeholders are documented inside the message text. A structured `error.next_flush_time` may exist in observed responses, but it is **not a documented contract**. Iroha should continue accepting it defensively without calling it authoritative, and should not parse localized human-readable messages unless a stable format is established.
7. The adapter accepts `error.type`, `error.upstream_code`, and `error.upstream_type`, but those are not part of the documented native Z.ai/BigModel envelope. Accepting them is harmless compatibility behavior; they should not be described as guaranteed Z.ai fields.
8. The adapter has no path for abnormal SSE `finish_reason` values, which the official docs identify as the failure channel after a stream has started.

## Retry and Capacity Evidence boundaries

Z.ai's general HTTP guide recommends exponential backoff, reasonable timeouts, and bounded retry limits, but does not publish a per-code retry algorithm. [Z.ai HTTP API guide](https://docs.z.ai/guides/develop/http/introduction)

Accordingly:

- Bounded retry/backoff is supported by the documented meaning for generic 5xx, 1200, 1230, 1234, 1302, and 1305.
- 1308, 1310, and 1316-1321 support waiting until their reset, but the machine-readable reset representation is undocumented.
- Authentication, malformed request, safety, missing permission, balance/package absence, expired packages, wrong product key, and missing-model entitlement should not be blindly retried unchanged.
- HTTP 429 alone is not Capacity Evidence. The table uses 429 for rate limiting, service overload, insufficient funds, subscription expiry, model entitlement, Fair Use restriction, enterprise-key mismatch, and multiple quota windows.
- The official table does not document actual Capacity Scope. Key scope may be a practical conservative choice for routing, but it remains an Iroha inference rather than a Provider guarantee.

## Uncertain or undocumented gaps

- No documented `Retry-After` header or rate-limit response-header schema was found. The linked “Rate Limits” navigation currently redirects to the authenticated management console rather than public protocol documentation.
- No documented structured reset field exists in the error schema; `next_flush_time` appears only as a message-template placeholder.
- No type/unit/format is specified for `next_flush_time`.
- 1113 intentionally conflates insufficient pay-as-you-go balance with absence of an applicable resource package, so it cannot establish an exact credit balance.
- No error endpoint here reports the remaining pay-as-you-go credit amount.
- 1310 conflates weekly and monthly limits.
- The docs do not state whether limits are scoped to an API key, account, sub-account, Provider/model, or Provider globally.
- The current tables omit some codes found in older documentation snapshots (for example 1002/1004 and several account/policy codes). Treat the present list as current, not necessarily exhaustive; retain unknown-code diagnostics and HTTP fallback.
- The docs do not define safe replay/idempotency semantics after a mid-stream `network_error`.
