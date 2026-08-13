# Iroha Gateway

Iroha presents one self-hosted API through which its owner can use multiple AI inference services.

## Language

**Gateway**:
The single OpenAI-compatible API exposed by Iroha to its owner's applications.
_Avoid_: Proxy, aggregator

**Provider**:
The owner-managed entity through which the Gateway reaches one upstream AI inference service. It has a stable ID, a base URL, and holds Upstream Keys. Each Upstream Key may declare its own base URL override; when unset, the key uses the Provider's base URL. The Provider owns every transport, authentication, retry, timeout, capability, and idempotency setting the Gateway uses to reach the upstream. It is seeded by a Provider Template that identifies the upstream brand.
_Avoid_: Vendor, backend, account, integration, provider connection

**Upstream Key**:
A secret issued by a Provider and attached to one Provider for upstream inference requests. It may declare its own base URL; when set, the key sends requests there; when unset, the key uses the Provider's base URL.
_Avoid_: Gateway Key, token, credential

**Upstream Account**:
An optional grouping of Upstream Keys that share the same Provider billing account or capacity limits. A limit known to affect the account makes every key in that group temporarily or durably ineligible.
_Avoid_: Owner, key pool

**Capacity Scope**:
The resource affected by an upstream limit: one key, an Upstream Account, a provider-and-model pair, an entire Provider, or an unknown scope.
_Avoid_: Rate limit, quota

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
The Providers and optional Upstream Models that a Gateway Key permits its application to use and discover.
_Avoid_: Role, permissions

**Key Health**:
Iroha's durable knowledge of whether an Upstream Key is active, temporarily cooling down, invalid, exhausted, or disabled by the Owner.
_Avoid_: Status, availability

**Test verdict**:
The result of one probe of an Upstream Key against its upstream: `usable`, `rejected`, or `inconclusive`. The verdict is recorded on the key's `lastProbe` and surfaces in the Owner UI as the inline test feedback in the key's row.
_Avoid_: Result, outcome, status
