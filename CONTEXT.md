# Iroha Gateway

Iroha presents one self-hosted API through which its owner can use multiple AI inference services.

## Language

**Gateway**:
The self-hosted API exposed by Iroha to its owner's applications. It offers provider-scoped surfaces for callers that select a Provider in the URL and global surfaces for callers that select a Provider with a Qualified Model ID; either surface accepts the OpenAI-compatible or Anthropic-compatible caller shape supported by its route.
_Avoid_: Proxy, aggregator

**Request**:
One complete caller-visible exchange with the Gateway. Its outcome, HTTP status, latency, and usage describe what the caller ultimately received, even when reaching that result required multiple Attempts.
_Avoid_: Attempt, upstream request

**Attempt**:
One transmission from the Gateway to a Provider within a Request. Each Attempt retains its own outcome, HTTP status, Upstream Key, timing, and bounded diagnostics so retries remain independently observable.
_Avoid_: Request, retry request

**Provider**:
The owner-managed entity through which the Gateway reaches one upstream AI inference service. It has a stable ID, a base URL, and holds Upstream Keys. Each Upstream Key may declare its own base URL override; when unset, the key uses the Provider's base URL. The Provider owns every transport, authentication, retry, timeout, capability, and idempotency setting the Gateway uses to reach the upstream. It is seeded by a Provider Template that identifies the upstream brand.
_Avoid_: Vendor, backend, account, integration, provider connection

**Upstream Key**:
A secret issued by a Provider and attached to one Provider for upstream inference requests. It may declare its own base URL; when set, the key sends requests there; when unset, the key uses the Provider's base URL.
_Avoid_: Gateway Key, token, credential

**Upstream Account**:
A legacy grouping of Upstream Keys believed to share one Provider billing account or capacity limit. It is planned for removal; new Gateway behavior must treat each Upstream Key independently rather than depend on this grouping.
_Avoid_: Owner, key pool

**Capacity Scope**:
The resource affected by an upstream limit: one key, an Upstream Account, a provider-and-model pair, an entire Provider, or an unknown scope.
_Avoid_: Rate limit, quota

**Capacity Evidence**:
A time-stamped Provider observation about whether a Capacity Scope is available, exhausted, temporarily limited, or unknown. Authoritative evidence comes from a Provider entitlement surface; observed inference failures remain provisional until a Provider-specific adapter can interpret them.
_Avoid_: Usage status, quota result

**Routing Eligibility**:
The Gateway's derived decision that an Upstream Key may receive a new inference request. An Owner-enabled key is eligible only when its credential evidence and capacity evidence do not establish that it is invalid or exhausted.
_Avoid_: Active status, round-robin status

**Upstream Model**:
A model offered by a Provider and addressed by its exact Provider-defined model name.
_Avoid_: Alias, virtual model

**Provider Directory**:
The authenticated list of Providers a Gateway Key is permitted to use, including their exact Upstream Models and supported inference capabilities.
_Avoid_: Provider catalog, registry

**Usage Adapter**:
Provider-specific knowledge that can read authoritative balance or plan usage when the Provider exposes it. A generic adapter can observe inference failures but cannot claim an authoritative remaining balance.
_Avoid_: Billing API, quota checker

**Inference Adapter**:
Typed knowledge for speaking a Provider's inference API, including authentication, endpoint capabilities, and provider-specific failure classification. The generic form preserves the OpenAI-compatible request and response shape.
_Avoid_: Plugin, driver, provider

**Failure Classification**:
An Inference Adapter's interpretation of one failed Provider response: the failure kind, affected Capacity Scope, safe Retry Action, and known retry timing. An unknown classification may guide a request-local fallback without asserting durable Key Health.
_Avoid_: Status mapping, error table

**Retry Action**:
The bounded next step a Failure Classification permits: stop, retry the same Upstream Key, or try an eligible alternate. It does not itself change durable Key Health.
_Avoid_: Retry policy, failover rule

**Provider Template**:
A built-in setup aid that supplies known defaults for creating a Provider without containing an account or secret.
_Avoid_: Adapter, preset

**Owner**:
The person operating an Iroha installation and supplying all Provider credentials used by it.
_Avoid_: Tenant, customer, administrator

**Owner Session**:
One signed-in browser holding the Owner's authenticated cookie. It has a stable ID, slides its own expiry while in use, and can be listed and revoked without changing the password.
_Avoid_: Login (as a noun), token, Gateway Key

**Gateway Key**:
A secret created by the Owner that authorizes an application to call the Gateway without exposing any Upstream Key.
_Avoid_: Upstream Key, virtual key, user key

**Key Scope**:
The access policy that determines which Providers and Upstream Models a Gateway Key permits its application to use and discover. It is either unrestricted, dynamically covering every active Provider and model, or selected, covering only its listed Providers and optional models.
_Avoid_: Role, permissions

**Qualified Model ID**:
A Gateway-facing model identifier in the form `<provider_id>/<model_id>` that selects both one Provider and one exact Upstream Model for a global API call. The first slash is the separator; every character after it belongs to the Upstream Model's exact ID.
_Avoid_: Alias, virtual model, prefixed model

**Key Health**:
Iroha's durable knowledge of whether an Upstream Key is active, temporarily cooling down, invalid, exhausted, or disabled by the Owner.
_Avoid_: Status, availability

**Credential Evidence**:
The result of probing whether an Upstream Key is accepted for a low-cost Provider operation: `authenticated`, `rejected`, or `inconclusive`. Authentication does not establish capacity or Routing Eligibility and cannot by itself clear authoritative exhaustion.
_Avoid_: Test verdict, usable, Key Health

**Provider Diagnostics**:
Bounded, allow-listed facts retained from a Provider response to explain a Failure Classification or Capacity Evidence, such as HTTP status, Provider error code/type, limiting window, and retry timing. It excludes raw bodies, arbitrary messages, prompts, responses, headers, and secrets.
_Avoid_: Error dump, upstream response
