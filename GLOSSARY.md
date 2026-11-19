# Iroha

Iroha is one self-hosted Gateway through which its Owner, their friends, and their agents use many AI inference services, without caring which upstream secret serves each call.

## Language

### People and credentials

**Owner**:
The one person who runs an Iroha installation and supplies every Upstream Key it uses.
_Avoid_: Admin, tenant, user

**Caller**:
An application or person sending inference to the Gateway, identified by the Gateway Key it presents.
_Avoid_: Client, consumer, user

**Gateway Key**:
A secret Iroha issues to one Caller, restricted to chosen Providers and, within them, chosen models.
_Avoid_: API key, token, Upstream Key

**Admin Token**:
A named secret that grants full management of Iroha to the Owner or to one of the Owner's agents.
_Avoid_: Management Key, admin key, Gateway Key

### Upstreams

**Gateway**:
The single inference surface Iroha exposes to Callers.
_Avoid_: Proxy, aggregator, router

**Provider**:
One upstream AI inference service as the Owner has configured it in Iroha, holding the Upstream Keys used to reach it.
_Avoid_: Vendor, backend, channel, connection

**Endpoint**:
One URL of a Provider that speaks one Shape, such as a region, a plan-specific URL, or an Anthropic-compatible URL. An Upstream Key works on all of its Provider's Endpoints unless restricted to some.
_Avoid_: Base URL, surface, host

**Shape**:
One API format a request or response can be written in, such as OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, or Gemini. A Caller may use any Shape; a Provider may speak several.
_Avoid_: Protocol, format, wire shape, API style

**Model Pool**:
A model name Callers can ask for that is served, in a chosen order, by models on several Providers.
_Avoid_: Alias, virtual model, family provider, route

**Upstream Key**:
A secret issued by a Provider's service and held by Iroha to make Attempts against it; Callers never see it.
_Avoid_: Gateway Key, credential, channel key

**Key State**:
The one visible condition an Upstream Key is in at any moment (active, disabled, invalid, or cooling), always paired with the reason it entered that state.
_Avoid_: Key health, capacity, eligibility

**Cooling**:
The Key State of an Upstream Key, or of one Upstream Key for one model, that the Provider has temporarily refused until a known time.
_Avoid_: Rate-limited, exhausted, parked

**Model Gap**:
A remembered fact that one Upstream Key was refused one model, so that model is not sent to that key until the gap expires or is cleared.
_Avoid_: Allow-list, deny-list, key model availability, entitlement

**Endpoint Gap**:
A remembered fact that one Upstream Key was refused on one Endpoint after it had worked on another of its Provider's, so it is not sent to that Endpoint until the gap is cleared, and keeps its Key State and its other Endpoints.
_Avoid_: Invalid on an Endpoint, partial invalid, region block, Endpoint ban

**Failure Rule**:
A named rule that recognises a Provider's failed response and says what it means for the Upstream Key, the model, and the Request; built-in or added by the Owner.
_Avoid_: Adapter, classifier, error mapping, quirk

### Traffic and history

**Request**:
One complete exchange between a Caller and the Gateway, described by what the Caller ultimately received.
_Avoid_: Call, attempt, upstream request

**Attempt**:
One transmission from the Gateway to a Provider using one Upstream Key, made while serving a Request.
_Avoid_: Request, retry

**Audit Entry**:
A record of one change to Iroha's configuration, naming the Owner session or Admin Token that made it.
_Avoid_: Log, event, history
