# Iroha Gateway

Iroha presents one self-hosted API through which its owner can use multiple AI inference services.

## Language

**Gateway**:
The single OpenAI-compatible API exposed by Iroha to its owner's applications.
_Avoid_: Proxy, aggregator

**Provider**:
An upstream AI inference service that may be reached through one or more Provider Connections.
_Avoid_: Vendor, backend, connection

**Provider Connection**:
One owner-configured account or server through which the Gateway reaches a Provider. It has a stable ID and may hold multiple Upstream Keys.
_Avoid_: Provider, integration, account

**Upstream Key**:
A secret issued by a Provider and attached to one Provider Connection for upstream inference requests.
_Avoid_: Gateway Key, token, credential

**Upstream Account**:
An optional grouping of Upstream Keys that share the same Provider billing account or capacity limits. A limit known to affect the account makes every key in that group temporarily or durably ineligible.
_Avoid_: Owner, Provider Connection, key pool

**Capacity Scope**:
The resource affected by an upstream limit: one key, an Upstream Account, a connection-and-model pair, an entire Provider, or an unknown scope.
_Avoid_: Rate limit, quota

**Upstream Model**:
A model offered by a Provider and addressed by its exact Provider-defined model name.
_Avoid_: Alias, virtual model

**Provider Directory**:
The authenticated list of Provider Connections a Gateway Key is permitted to use, including their exact Upstream Models and supported inference capabilities.
_Avoid_: Provider catalog, registry

**Usage Adapter**:
Provider-specific knowledge that can read authoritative balance or plan usage when the Provider exposes it. A generic adapter can observe inference failures but cannot claim an authoritative remaining balance.
_Avoid_: Billing API, quota checker

**Inference Adapter**:
Typed knowledge for speaking a Provider Connection's inference API, including authentication, endpoint capabilities, and provider-specific failure classification. The generic form preserves the OpenAI-compatible request and response shape.
_Avoid_: Plugin, driver, provider

**Provider Template**:
A built-in setup aid that supplies known defaults for creating a Provider Connection without containing an account or secret.
_Avoid_: Provider Connection, adapter, preset

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
The Provider Connections and optional Upstream Models that a Gateway Key permits its application to use and discover.
_Avoid_: Role, permissions

**Key Health**:
Iroha's durable knowledge of whether an Upstream Key is active, temporarily cooling down, invalid, exhausted, or disabled by the Owner.
_Avoid_: Status, availability
