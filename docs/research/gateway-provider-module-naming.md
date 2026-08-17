# What production gateways call "one provider's built-in knowledge"

Prior-art survey for naming the module that bundles, for a single
upstream vendor: its default endpoint, its authentication shape, its
known model list, its request/response adapter, and — where it exists —
its usage/billing/quota adapter.

Every claim below cites a source file (current `main`/`master`) or a
documentation URL. Nothing here is sourced from blog posts or
second-hand summaries.

The question this answers: Iroha needs a noun for the bundle of
`{Provider Template + Inference Adapter + Usage Adapter}` described in
`docs/adapters.md`. The candidates on the table are **Provider Kind**,
**Provider Definition**, and **Provider Pack**. The survey below
establishes (a) what the field already calls this thing and (b) which
nouns are already spoken for.

---

## TL;DR

1. **In prose, every gateway surveyed calls it a "provider."** Without
   exception: LiteLLM, Bifrost, Portkey, OpenRouter, Cloudflare, Vercel
   AI SDK, LangChain, Helicone, Kong and Envoy AI Gateway all use that
   word in user-facing documentation. The only competing prose nouns
   anywhere in the survey are Microsoft's **connector** (Semantic
   Kernel, an SDK not a gateway) and Datasette `llm`'s **plugin**.
   In *code*, the only divergence is Kong's `kong/llm/drivers/`.
2. **Nobody uses "kind," "definition," "pack," "profile," or
   "blueprint" for the provider module.** Two of those words are
   spoken for by *neighbouring* concepts, though — see §12.
3. **Most projects have no single object for the bundle at all.**
   LiteLLM has ~15 separately-registered `Config` classes per vendor
   and never names their union. Envoy splits it across three CRDs.
   Only Bifrost (`schemas.Provider`), Helicone (`BaseProvider`) and
   Portkey (`ProviderConfigs`) have one named per-vendor object.
4. **Nobody bundles billing into the provider module by default.**
   The dominant split is: the provider module owns *protocol* (URL,
   auth, transform, error mapping), and pricing lives in a *separate
   central catalog* — LiteLLM's
   `model_prices_and_context_window.json`, Bifrost's **Model Catalog**,
   LangChain's LangSmith, Cloudflare's observability layer. Only
   OpenRouter and Helicone keep price on the provider/endpoint record,
   and both are billing products first. **No project surveyed has an
   equivalent of Iroha's Usage Adapter** (reading the vendor's own
   authoritative balance/quota API).
5. **The ID is almost always a lowercase slug**: `anthropic`. It is
   called a "provider slug" (OpenRouter, Cloudflare), a "provider key"
   (Bifrost `GetProviderKey`, LangChain), a "provider name"
   (`ModelProviderName`, `custom_llm_provider`), or a "Provider ID"
   (models.dev).
6. Of the three candidates, **"Provider Pack" is the only one with no
   conflicting use**; "Kind" is burned by Kubernetes and "Definition"
   is burned both by the LLM APIs themselves ("tool definition") and
   by the two projects closest to Iroha's data layout, which already
   use it for the *per-model* record.

Summary table is in [§11](#11-summary-table).

---

## 1. LiteLLM (Python)

**Repo**: `BerriAI/litellm`. **Docs**: `docs.litellm.ai`.

### Code noun: `<Provider>Config`, subclassing `BaseConfig`

The per-provider module is a directory under `litellm/llms/`, one per
provider — `litellm/llms/anthropic/`, `litellm/llms/openai/`,
`litellm/llms/bedrock/`, `litellm/llms/dashscope/`, and so on
(`https://github.com/BerriAI/litellm/tree/main/litellm/llms`).

The unit of behaviour inside it is a **Config** class. LiteLLM's own
`ARCHITECTURE.md:355-357` states it plainly:

> Each provider has a `Config` class that inherits from `BaseConfig`
> (`llms/base_llm/chat/transformation.py`)

…and illustrates it with a class literally named `ProviderConfig`
(`ARCHITECTURE.md:358-366`):

```python
class ProviderConfig(BaseConfig):
    def transform_request(self, model, messages, optional_params, litellm_params, headers):
        # Convert OpenAI format → Provider format
    def transform_response(self, model, raw_response, model_response, logging_obj, ...):
        # Convert Provider format → OpenAI format
```

`BaseConfig` is an ABC at
`litellm/llms/base_llm/chat/transformation.py:65`. Its abstract and
optional surface covers exactly the "built-in knowledge" this survey is
about:

| `BaseConfig` member | Line | What it owns |
|---|---|---|
| `validate_environment(...)` (abstract) | `:239-250` | Auth header construction |
| `sign_request(...)` | `:252-276` | Request signing (Bedrock/SigV4) |
| `get_complete_url(...)` | `:277-296` | Endpoint construction |
| `transform_request(...)` (abstract) | `:297-328` | OpenAI → provider |
| `transform_response(...)` (abstract) | `:329-345` | Provider → OpenAI |
| `get_supported_openai_params(model)` (abstract) | `:179-182` | Capability declaration |
| `map_openai_params(...)` (abstract) | `:229-238` | Parameter translation |
| `get_error_class(...)` (abstract) | `:357-360` | Failure classification |
| `get_model_response_iterator(...)` | `:361-383` | Streaming adapter |
| `calculate_additional_costs(...)` | `:428-444` | Provider-specific extra cost |

The model-list half lives in a *sibling* ABC, `BaseLLMModelInfo` at
`litellm/llms/base_llm/base_utils.py:43`, whose abstract methods are
`get_models(api_key, api_base)` (`:53-58`), `get_api_key(...)`
(`:60-64`), `get_api_base(...)` (`:65-71`), `validate_environment(...)`
(`:72-84`) and `get_base_model(model)` (`:85-94`). A provider that
supports dynamic model listing implements both — `AnthropicConfig` and
`AnthropicModelInfo` are separate classes in the same directory.

### The registry: `ProviderConfigManager`

`litellm/utils.py:7777` declares:

```python
class ProviderConfigManager:
    # Dictionary mapping for O(1) provider lookup
    # Stores tuples of (factory_function, needs_model_parameter)
    _PROVIDER_CONFIG_MAP: dict[LlmProviders, tuple[Callable, bool]] | None = None
```

The map is built in `_build_provider_config_map()` at
`litellm/utils.py:7784-7790` with entries like
`LlmProviders.ANTHROPIC: (lambda: litellm.AnthropicConfig(), False)`
(`litellm/utils.py:7794`).

Crucially, there is **one lookup method per API surface**, not one per
provider — `get_provider_chat_config` (`litellm/utils.py:8027`),
`get_provider_embedding_config` (`:8078`), `get_provider_rerank_config`
(`:8165`), `get_provider_anthropic_messages_config` (`:8211`),
`get_provider_audio_transcription_config` (`:8284`),
`get_provider_responses_api_config` (`:8365`),
`get_provider_model_info` (`:8524`), `get_provider_passthrough_config`
(`:8572`), `get_provider_files_config` (`:8614`),
`get_provider_batches_config` (`:8643`),
`get_provider_image_generation_config` (`:8755`),
`get_provider_video_config` (`:8864`), and about a dozen more.

**This is the shape Iroha is trying to avoid naming twice.** LiteLLM
never gives the *union* of those configs a name. There is no
`AnthropicProvider` object. "The Anthropic provider" is, in LiteLLM,
an emergent property of ~15 independently-registered config classes
that happen to share a directory and an enum member.

### The ID: `LlmProviders` enum / `custom_llm_provider` string

`litellm/types/utils.py:3584`:

```python
class LlmProviders(str, Enum):
    OPENAI = "openai"
    CHATGPT = "chatgpt"
    OPENAI_LIKE = "openai_like"  # embedding only
    JINA_AI = "jina_ai"
    XAI = "xai"
    ZAI = "zai"
    ...
    ANTHROPIC = "anthropic"
    ANTHROPIC_TEXT = "anthropic_text"
    ...
```

with `LlmProvidersSet: Final = {provider.value for provider in LlmProviders}`
at `litellm/types/utils.py:3737`. The string form is carried through
the whole codebase under the parameter name **`custom_llm_provider`**.

Note the enum also has `SearchProviders` (`litellm/types/utils.py:3750`)
and `SandboxProviders` (`:3780`) siblings — "provider" is LiteLLM's
generic word for "upstream vendor of any kind."

### Does it bundle usage/billing?

Partly, and the split is instructive.

- The **price table is central**, not per-provider:
  `model_prices_and_context_window.json` at the repo root (HTTP 200 at
  `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`),
  mirrored into the package as
  `litellm/model_prices_and_context_window_backup.json`, and consumed
  by `litellm/cost_calculator.py`.
- The **cost *arithmetic* is per-provider**: several provider
  directories ship a cost module —
  `litellm/llms/anthropic/cost_calculation.py` ("Helper util for
  handling anthropic-specific cost calculation - e.g.: prompt
  caching"), `litellm/llms/openai/cost_calculation.py`,
  `litellm/llms/vertex_ai/cost_calculator.py`,
  `litellm/llms/gemini/cost_calculator.py` (all fetch 200).
- `BaseConfig.calculate_additional_costs(...)`
  (`litellm/llms/base_llm/chat/transformation.py:428-444`) is the
  in-config hook: *"provider-specific infrastructure costs, routing
  fees, etc."*

What LiteLLM does **not** have is Iroha's Usage Adapter — there is no
per-provider "go read the vendor's balance/quota API" abstraction on
`BaseConfig`. Budget enforcement is a proxy-side concern
(`GenericBudgetConfigType`, `litellm/types/utils.py` just above the
`LlmProviders` enum).

### Docs noun: "provider"

`docs.litellm.ai/docs/providers` is titled **"Providers"**; the nav
section is **"Supported Models & Providers"**; the opening line is
*"Learn how to deploy + call models from different providers on
LiteLLM."* One subsection is titled *"Integrate as a Model
Provider"* — "integrate" is used as a verb, never "integration" as the
noun for the module.

The contributor-facing docs call the artefact by its **file name**, not
by a concept noun: `docs.litellm.ai/docs/adding_provider/directory_structure`
prescribes

```
litellm/llms/
└── provider_name/
    ├── completion/
    │   ├── handler.py
    │   └── transformation.py
    ├── chat/
    │   ├── handler.py
    │   └── transformation.py
```

and `docs.litellm.ai/docs/adding_provider/new_rerank_provider` instructs
*"Create a `transformation.py` file"* and *"Create a config class named
`<Provider><Endpoint>Config`"*. `ARCHITECTURE.md:372-378` ("Adding a
new provider") gives the same three steps.

### The user-extension escape hatch: `CustomLLM`

`docs.litellm.ai/docs/providers/custom_llm_server` registers a
user-written provider through:

```python
litellm.custom_provider_map = [
    {"provider": "my-custom-llm", "custom_handler": my_custom_llm}
]
```

The class to subclass is `CustomLLM`; the registry variable is
`litellm.custom_provider_map`; the ID key is literally `"provider"` and
the behaviour key is `"custom_handler"`. So even LiteLLM's *plugin*
seam is named "provider" + "handler", not "plugin" or "adapter."

### Adjacent nouns that ARE taken in LiteLLM

- **Deployment** — `litellm/types/router.py:506` (`class Deployment`)
  and `:497` (`DeploymentTypedDict`). A Deployment is one row of the
  proxy's `model_list`: a model name bound to a specific
  provider+key+base_url. This is the closest LiteLLM analogue to
  Iroha's *Provider Connection*, not to the built-in bundle.
- **Model Group** — `litellm/types/router.py:608`
  (`class ModelGroupInfo`): the set of Deployments sharing a public
  model alias.
- **Config** — thoroughly overloaded: `<Provider>Config` (the adapter),
  `RouterConfig` (`litellm/types/router.py:57`), and the proxy YAML
  ("config.yaml") all use it.

---

## 2. Bifrost (Go)

**Repo**: `maximhq/bifrost`. **Docs**: `docs.getbifrost.ai`.

Bifrost is the one project in the survey that has a **single named
object per vendor**, and it calls it `Provider`.

### Code noun: the `Provider` interface

`core/schemas/provider.go:631`:

```go
// Provider defines the interface for AI model providers.
type Provider interface {
	// GetProviderKey returns the provider's identifier
	GetProviderKey() ModelProvider
	// ListModels performs a list models request
	ListModels(ctx *BifrostContext, keys []Key, request *BifrostListModelsRequest) (*BifrostListModelsResponse, *BifrostError)
	TextCompletion(...) ...
	ChatCompletion(...) ...
	ChatCompletionStream(...) ...
	Responses(...) ...
	CountTokens(...) ...
	Embedding(...) ...
	Rerank(...) ...
	Speech(...) / Transcription(...) / ImageGeneration(...) / ImageEdit(...) ...
}
```

with two optional extension interfaces alongside it —
`ResponsesLifecycleProvider` (`core/schemas/provider.go:753`) and
`WebSocketCapableProvider` (`:767`).

Implementations live one directory per vendor under
`core/providers/<name>/` — e.g. `core/providers/anthropic/anthropic.go`,
whose constructor is `NewAnthropicProvider(config, logger)`.

**Contrast with LiteLLM:** where LiteLLM has ~15 separately-registered
`Config` classes per vendor and no union object, Bifrost has exactly
one `Provider` value per vendor holding every operation. That single
object is the closest published analogue to what Iroha wants to name.

### The registry: a `switch` in `createBaseProvider`

`core/bifrost.go:4384-4400`:

```go
func (bifrost *Bifrost) createBaseProvider(providerKey schemas.ModelProvider, config *schemas.ProviderConfig) (schemas.Provider, error) {
	...
	switch targetProviderKey {
	case schemas.OpenAI:
		return openai.NewOpenAIProvider(config, bifrost.logger), nil
	case schemas.Anthropic:
		return anthropic.NewAnthropicProvider(config, bifrost.logger), nil
	case schemas.Bedrock:
		return bedrock.NewBedrockProvider(config, bifrost.logger)
	...
```

Lookup at runtime is `getProviderByKey(providerKey schemas.ModelProvider)`
(`core/bifrost.go:4886`), with per-provider mutexes and queues
(`getProviderMutex`, `:3919`; `getProviderQueue`, `:4504`).

### The ID: `schemas.ModelProvider`

`core/schemas/bifrost.go:43-75`:

```go
type ModelProvider string

const (
	OpenAI        ModelProvider = "openai"
	Azure         ModelProvider = "azure"
	Anthropic     ModelProvider = "anthropic"
	Bedrock       ModelProvider = "bedrock"
	...
)
```

The interface method that returns it is `GetProviderKey()`, so the ID is
called both a **provider key** and a **`ModelProvider`** depending on
where you look.

### Trap: `ProviderConfig` in Bifrost is NOT the built-in knowledge

This is the most important terminology trap in Bifrost.
`core/schemas/provider.go:550`:

```go
// ProviderConfig represents the complete configuration for a provider.
// An array of ProviderConfig needs to be provided in GetConfigForProvider
// in your account interface implementation.
type ProviderConfig struct {
	NetworkConfig            NetworkConfig
	ConcurrencyAndBufferSize ConcurrencyAndBufferSize
	Logger                   Logger
	ProxyConfig              *ProxyConfig
	SendBackRawRequest       bool
	SendBackRawResponse      bool
	StoreRawRequestResponse  bool
	CustomProviderConfig     *CustomProviderConfig
	OpenAIConfig             *OpenAIConfig
}
```

That is **operator-supplied runtime config** — timeouts, retries,
concurrency, proxy — not endpoint/auth/model knowledge. In LiteLLM
`<Provider>Config` means the adapter; in Bifrost `ProviderConfig`
means the deployment knobs. **The same two words mean opposite things
in the two biggest OSS gateways**, which is on its own a reason to stop
using bare "Config" for this concept.

### Bifrost's own "template" pattern: `CustomProviderConfig`

`core/schemas/provider.go:531-541`:

```go
type CustomProviderConfig struct {
	CustomProviderKey    string                 // internally set by Bifrost
	IsKeyLess            bool
	BaseProviderType     ModelProvider          // Base provider type
	AllowedRequests      *AllowedRequests
	RequestPathOverrides map[RequestType]string
}
```

Validated by `IsSupportedBaseProvider(config.CustomProviderConfig.BaseProviderType)`
(`core/bifrost.go:4374`). This is structurally identical to Iroha's
"a Provider Template that points at the Generic OpenAI Inference
Adapter": a named vendor entry that *delegates* to a base provider's
typed behaviour and only overrides paths and allowed operations. **Bifrost
gives this no distinct noun** — it is just "a custom provider" whose
`BaseProviderType` is `openai`.

### Trap: "Plugin" is taken by Bifrost for middleware

`docs.getbifrost.ai` lists "Supported providers" as a top-level section
(*"Bifrost supports 20+ AI providers through a single unified API"*) and,
separately, "Custom Plugins" under Open source features:
*"Extensible middleware architecture. Build Go or WASM plugins for
custom logic."* In Bifrost, **plugin = request-pipeline middleware**,
not vendor support. Governance/budgets ship as
`plugins/governance/`.

### Does it bundle usage/billing? No — that's the **Model Catalog**

`https://docs.getbifrost.ai/architecture/framework/model-catalog`
describes *"a centralized system for managing model information,
pricing, and capabilities across all supported AI providers"* and
*"a centralized repository for all model-related information."* It
*"downloads a pricing sheet from Maxim's datasheet"* (default
`https://getbifrost.ai/datasheet`), persists it to the config store,
caches it in memory, and re-syncs every 24 hours. Live model lists are
refreshed on a separate `bifrost.framework.pricing.liveModelsSyncInterval`
(default 3600 s).

So Bifrost's split is: **`Provider` = protocol; `Model Catalog` =
pricing/capability metadata; `plugins/governance` = budget
enforcement.** The `Provider` interface itself has `ListModels` but no
pricing and no quota-reading method.

---

## 3. Portkey Gateway (TypeScript)

**Repo**: `Portkey-AI/gateway`. **Docs**: `portkey.ai/docs`.

### Code noun: `ProviderConfigs` (plural) — the per-vendor bundle

Each vendor is a directory `src/providers/<name>/` whose `index.ts`
default-exports one object. `src/providers/anthropic/index.ts`:

```ts
import { ANTHROPIC } from '../../globals';
import { ProviderConfigs } from '../types';
import AnthropicAPIConfig from './api';
...
const AnthropicConfig: ProviderConfigs = {
  complete: AnthropicCompleteConfig,
  chatComplete: AnthropicChatCompleteConfig,
  messages: AnthropicMessagesConfig,
  messagesCountTokens: AnthropicMessagesConfig,
  api: AnthropicAPIConfig,
  responseTransforms: {
    'stream-complete': AnthropicCompleteStreamChunkTransform,
    complete: AnthropicCompleteResponseTransform,
    chatComplete: getAnthropicChatCompleteResponseTransform(ANTHROPIC),
    'stream-chatComplete': getAnthropicStreamChunkTransform(ANTHROPIC),
    messages: AnthropicMessagesResponseTransform,
  },
};

export default AnthropicConfig;
```

**The singular/plural distinction is load-bearing** and easy to
misread. From `src/providers/types.ts`:

| Type | Line | Meaning |
|---|---|---|
| `ParameterConfig` | `:19` | One request parameter's mapping — `param`, `default`, `min`, `max`, `required`, `transform` |
| `ProviderConfig` | `:38` | *"Configuration for an AI provider"* — but it is `{ [key: string]: ParameterConfig \| ParameterConfig[] }`, i.e. **one endpoint's parameter map**, not a provider |
| `ProviderAPIConfig` | `:47` | *"Configuration for an AI provider's API"* — `headers()`, `getBaseURL()`, `getEndpoint()`, `transformToFormData?()`, `getProxyEndpoint?()` |
| `ProviderAPIConfigs` | `:126` | *"The API configuration for each provider, indexed by provider name"* |
| `RequestHandlers` | `:141` | `Partial<Record<endpointStrings, RequestHandler<any>>>` |
| **`ProviderConfigs`** | `:149` | *"A collection of configurations for multiple AI providers"* — `{ [key: string]: any; requestHandlers?; getConfig?() }` |

So `ProviderConfig` (singular) is **one endpoint's parameter map**;
`ProviderConfigs` (plural) is **the whole vendor bundle**. The JSDoc on
`ProviderConfigs` (*"for multiple AI providers"*) is arguably stale —
in practice each vendor's `index.ts` exports exactly one
`ProviderConfigs` object keyed by `endpointStrings`.

`endpointStrings` (`src/providers/types.ts:85-124`) enumerates the ~35
surfaces a bundle may implement: `complete`, `chatComplete`, `embed`,
`rerank`, `moderate`, `stream-complete`, `stream-chatComplete`,
`stream-messages`, `proxy`, `imageGenerate`, `createSpeech`,
`createTranscription`, `realtime`, `uploadFile`, `createBatch`,
`createModelResponse`, `messages`, `messagesCountTokens`, …

### The registry: `Providers`

`src/providers/index.ts:78`:

```ts
const Providers: { [key: string]: ProviderConfigs } = {
  ...
  anthropic: AnthropicConfig,
  ...
  'inference-net': InferenceNetProviderConfigs,
  ...
};
export default Providers;   // :153
```

### The ID: a lowercase slug constant in `src/globals.ts`

```ts
export const POWERED_BY: string = 'portkey';   // src/globals.ts:3
export const ANTHROPIC: string = 'anthropic';  // src/globals.ts:47
```

The same string is the registry key and the value passed into the
response transforms (`getAnthropicChatCompleteResponseTransform(ANTHROPIC)`),
which is how the error envelope ends up carrying
`"provider": "anthropic"`.

### Does it bundle usage/billing? No.

A `ProviderConfigs` object contains request configs, an API config, and
response transforms. It has no pricing table and no quota reader. Usage
handling is limited to *reshaping* the vendor's reported token counts
into OpenAI's `usage` object inside the response transform (see
`getAnthropicChatCompleteResponseTransform` in
`src/providers/anthropic/chatComplete.ts`, analysed in
`docs/research/anthropic-gateway-implementations.md` §A.2). Cost and
budgets are Portkey's hosted control-plane concern, not the OSS
gateway's.

### Docs noun: "provider" for the vendor, "integration" for the page

`https://portkey.ai/docs/integrations/llms` is headed **"Supported AI
Providers"** and opens *"Portkey connects with all major LLM providers
and orchestration frameworks."* The URL space is
`/docs/integrations/llms/<vendor>` and `/docs/integrations/libraries/…`,
so the nav noun is **Integrations** while the object noun is
**provider**. Portkey reserves "integration" mostly for *frameworks*
(*"native integrations with the following frameworks"*).

### Trap: "Template" is taken by Portkey for prompts

Portkey's Prompt Library documents **Prompt Templates** as a
first-class, versioned product object powered by Mustache
(`https://portkey.ai/docs/product/prompt-engineering-studio/prompt-library`).
This is the general pattern across the LLM tooling ecosystem: bare
"template" means *prompt* template. Iroha's current
"Provider Template" survives only because of the qualifier.

---

## 4. OpenRouter (hosted)

**Docs only** — no public source.

### Noun: "provider" = the *serving host*, distinct from the *author*

`https://openrouter.ai/docs/features/provider-routing`: *"OpenRouter
routes requests to the best available providers for your model."* The
same page notes that *"each provider on OpenRouter may host multiple
endpoints for the same model"* — so OpenRouter has a second noun,
**endpoint**, for the (model × provider) pair.

OpenRouter deliberately separates **author** (who made the model) from
**provider** (who serves it). Model IDs are `{author}/{slug}` —
`"openai/gpt-4o"`, `"google/gemini-2.5-pro-preview"`
(`https://openrouter.ai/docs/guides/overview/models`). The distillation
page (`https://openrouter.ai/docs/guides/evaluate-and-optimize/distillation`)
uses both in one sentence: *"Some model providers and creators
explicitly prohibit using their model outputs to train other models"*,
and gates on *"models where the **author** has explicitly allowed text
distillation."*

**This author/provider split is the single most useful naming lesson in
the survey**: OpenRouter needed two words because "provider" alone was
ambiguous between "the brand behind the model" and "the endpoint that
serves it."

### The ID: "provider slug"

`https://openrouter.ai/docs/features/provider-routing` documents the
provider-preferences object with these fields, all doc-quoted:

| Field | Doc text |
|---|---|
| `order` | "List of provider slugs to try in order (e.g. `["anthropic", "openai"]`)" |
| `allow_fallbacks` | "Whether to allow backup providers when the primary is unavailable" |
| `require_parameters` | "Only use providers that support all parameters in your request" |
| `only` | "List of provider slugs to allow for this request" |
| `ignore` | "List of provider slugs to skip for this request" |
| `sort` | "Sort providers by price, throughput, or latency" |
| `max_price` | "The maximum pricing you want to pay for this request" |

Slugs can be sub-scoped: `"deepinfra/turbo"`, `"google-vertex/us-east5"`.

### Does it bundle usage/billing? Yes.

`GET https://openrouter.ai/api/v1/models/anthropic/claude-sonnet-4.5/endpoints`
returns an `endpoints[]` array where provider identity and commercial
metadata sit in the *same* object:

```json
{
  "name": "Amazon Bedrock | anthropic/claude-4.5-sonnet-20250929",
  "provider_name": "Amazon Bedrock",
  "tag": "amazon-bedrock",
  "pricing": { "prompt": "0.000003", "completion": "0.000015",
               "input_cache_read": "0.0000003", "input_cache_write": "0.00000375" },
  "context_length": 1000000,
  "max_completion_tokens": 64000,
  "status": 0,
  "uptime_last_30m": 99.92766928170033
}
```

The machine ID field here is `tag`. At the model level
(`/api/v1/models`) there is a `top_provider` object — *"Configuration
details for the primary provider"* — plus a model-level `pricing`
object described as *"Pricing from the top provider for this model."*

### "Integration" appears once, as a page title

`https://openrouter.ai/docs/guides/get-started/for-providers` is titled
**"Provider Integration"** and requires a vendor to *"implement an
endpoint that returns all models that should be served by OpenRouter"*
with pricing, capacity and modality metadata. So OpenRouter's own
model of "one vendor's bundled knowledge" is: *provider* +
*self-describing models endpoint*. No "adapter," "connector," "pack,"
or "kind" anywhere.

---

## 5. Cloudflare AI Gateway (hosted)

**Docs only** — no public source.

### Noun: "provider"; the URL space is `/ai-gateway/usage/providers/<slug>/`

From `https://developers.cloudflare.com/ai-gateway/llms.txt`, the
provider pages are `/ai-gateway/usage/providers/anthropic/`,
`/providers/bedrock/`, `/providers/grok/`, `/providers/workersai/`, etc.
The index page at `/ai-gateway/usage/providers/` renders as **"Provider
Native"** — *"Connect to AI providers using their native API formats
through AI Gateway."*

Routing base URL:
`https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/anthropic`
(`https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/`).
On the OpenAI-compatible surface
(`https://developers.cloudflare.com/ai-gateway/usage/chat-completion/`):
*"Specify the model using `{provider}/{model}` format. For example:
`openai/gpt-5-mini`, `google-ai-studio/gemini-2.5-flash`,
`anthropic/claude-sonnet-4-5`."*

### The closest analogue to Iroha's concept: **Custom Providers**

`https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/`:
*"Custom Providers allow you to integrate AI providers that are not
natively supported by AI Gateway."* Required fields are exactly the
identity/endpoint triple:

- `name` — *"Display name for your provider"*
- `slug` — *"Unique identifier (alphanumeric with hyphens)"*
- `base_url` — *"HTTPS URL for your provider's API endpoint"*

plus optional `description`, `link`, `enable`, `beta`, `curl_example`,
`js_example`. Auth is **not** stored on the provider record — the
bearer token is passed per request. So Cloudflare's user-facing
"provider" record is a strictly narrower thing than Iroha's bundle: it
is display metadata + base URL, with no transform and no usage reader.

### Does it bundle usage/billing? No — cost is central and estimated.

`https://developers.cloudflare.com/ai-gateway/observability/costs/`:
*"The cost metric is an estimation based on the number of tokens sent
and received in requests"*; *"Cost metrics are only available for
endpoints where the models return token data and the model name in
their responses"*; users are told to *"refer to your provider's
dashboard for the most accurate cost details."*

`https://developers.cloudflare.com/ai-gateway/features/` lists **Custom
Costs** — *"Override default pricing with your negotiated rates or
custom cost models"* — plus **Spend Limits**, **Dynamic Routing**,
**BYOK**, and **Analytics**, across *"20+ supported AI providers."*

**BYOK** (`/ai-gateway/configuration/bring-your-own-keys/`) is keyed
*per provider*, with multiple keys per provider selected by a
`cf-aig-byok-alias` header — structurally the same shape as Iroha's
Upstream Keys on a Provider. **Unified Billing**
(`/ai-gateway/features/unified-billing/`): *"Unified Billing allows
users to call Workers AI and connect to various AI providers … and
receive a single Cloudflare bill."*

### Counter-example inside Cloudflare: Workers AI says "model catalog"

`https://developers.cloudflare.com/workers-ai/` never says "provider" —
it offers *"50+ open-source models, available as a part of our model
catalog."* "Provider" is specific to the routing product.

---

## 6. Vercel AI SDK (TypeScript)

**Repo**: `vercel/ai`. **Docs**: `ai-sdk.dev`.

### Code noun: `ProviderV4` (was `ProviderV1`/`V2`/`V3`)

`packages/provider/src/provider/v4/provider-v4.ts` — JSDoc: *"Provider
for language, text embedding, and image generation models."*

```typescript
export interface ProviderV4 {
  readonly specificationVersion: 'v4';
  languageModel(modelId: string): LanguageModelV4;
  embeddingModel(modelId: string): EmbeddingModelV4;
  imageModel(modelId: string): ImageModelV4;
  transcriptionModel?(modelId: string): TranscriptionModelV4;
  speechModel?(modelId: string): SpeechModelV4;
  rerankingModel?(modelId: string): RerankingModelV4;
  files?(): FilesV4;
  skills?(): SkillsV4;
}
```

`main` currently carries `v2`, `v3` and `v4` side by side under
`packages/provider/src/provider/`; `ProviderV1` no longer exists there.
The v3 variant
(`packages/provider/src/provider/v3/provider-v3.ts`) is identical minus
`files`/`skills` and marks `textEmbeddingModel?()` as
*"@deprecated Use `embeddingModel` instead."*

**A Provider in the AI SDK is a pure model factory.** It has no
endpoint field, no auth field, no model list, no cost. Those live in
the concrete package's settings object —
`packages/openai/src/openai-provider.ts`:

```typescript
export interface OpenAIProviderSettings {
  /** Base URL for the OpenAI API calls. */ baseURL?: string;
  /** API key for authenticating requests. */ apiKey?: string;
  organization?: string; project?: string;
  headers?: Record<string, string>;
  /** Provider name. Overrides the `openai` default name for 3rd party providers. */ name?: string;
  fetch?: FetchFunction; webSocket?: WebSocketConstructor;
}
export function createOpenAI(options: OpenAIProviderSettings = {}): OpenAIProvider { ... }
export const openai = createOpenAI();
```

### The ID lives on the *model*, not the provider

`packages/provider/src/language-model/v4/language-model-v4.ts`:

```typescript
export type LanguageModelV4 = {
  readonly specificationVersion: 'v4';
  /** Provider ID. */
  readonly provider: string;
  /** Provider-specific model ID. */
  readonly modelId: string;
```

In practice the string is namespaced per surface —
`packages/openai/src/openai-provider.ts` passes `` `${providerName}.chat` ``,
`` `${providerName}.embedding` `` to its models.

### Docs noun: "provider", loosely "provider package"

`https://ai-sdk.dev/docs/foundations/providers-and-models`: *"Companies
such as OpenAI and Anthropic (providers) offer access to a range of
large language models (LLMs)."*
`https://ai-sdk.dev/providers/ai-sdk-providers` is headed **"AI SDK
Providers"**: *"The AI SDK comes with several providers that you can
use to interact with different language models."*
`https://ai-sdk.dev/providers/community-providers`: *"The AI SDK
provides a Language Model Specification. You can write your own
provider that adheres to the specification."* The authoring page is
titled *"Community Providers: Writing a Custom Provider."*

The repo's own authoring guide,
`skills/add-provider-package/SKILL.md`, is the one place the word
adapter appears for this concept: *"The AI SDK uses a layered provider
architecture following the adapter pattern."* Its description reads
*"Guide for adding new AI provider packages to the AI SDK. Use when
creating a new `@ai-sdk/<provider>` package to integrate an AI service
into the SDK."*

Note that in the *public* docs, **"Adapters" is a separate top-level
docs section** covering LangChain and LlamaIndex stream conversion —
i.e. the AI SDK has already spent "adapter" on something else.

### "Provider registry" and "custom provider"

`https://ai-sdk.dev/docs/ai-sdk-core/provider-management` and
`.../reference/ai-sdk-core/provider-registry`:

- **`createProviderRegistry({ providers, options? })`** — *"When you
  work with multiple providers and models, it is often desirable to
  manage them in a central place and access the models through simple
  string ids."* Models are addressed as `providerId:modelId` (default
  `:` separator).
- **`customProvider({ languageModels, embeddingModels, ..., fallbackProvider })`**
  — *"With a custom provider, you can map ids to any model. This allows
  you to set up custom model configurations, alias names, and more."*
  The return value is called a *"`Provider` instance."*

### Does it bundle usage/billing? No.

`ProviderV4`/`ProviderV3` expose only model factories.
`packages/provider/src/language-model/v3/language-model-v3-usage.ts`
carries token counts only — input `total`/`noCache`/`cacheRead`/`cacheWrite`,
output `total`/`text`/`reasoning`, plus a `raw` passthrough — with **no
cost or price field**. Commercial metadata is pushed out to a separate
product (the Vercel AI Gateway), which itself appears in the list as
just another provider.

---

## 7. LangChain / LangChain JS

### Docs noun: "integration package"; the vendor itself is a "provider"

Both nouns are live, at different levels.

- The landing page is titled **"LangChain Python integrations"** and
  defines the vendor dimension: a *provider* is *"a company or platform
  that hosts AI models and exposes them through an API"*
  (`https://docs.langchain.com/oss/python/integrations/providers/overview`;
  the old `python.langchain.com/docs/integrations/providers` 308-redirects
  here). The URL path is `/integrations/providers/`.
- The *vehicle* is an **"integration package"**, one per provider, named
  `langchain-<provider>`:
  *"All new integrations must be published as independent packages to
  PyPI (e.g., `langchain-yourprovider`)"*
  (`https://docs.langchain.com/oss/python/contributing/integrations`).
- **"Partner package"** is the legacy repo-layout term and now means
  *maintained by the LangChain team*, not *provider bundle* in general:
  *"Located in `libs/partners/`, these are independently versioned
  packages for specific integrations"*
  (`https://docs.langchain.com/oss/python/contributing/code`);
  `libs/README.md` calls the directory *"third-party provider
  integrations that are maintained directly by the LangChain team."*
  Contents of `libs/partners/`: `anthropic, chroma, deepseek, exa,
  fireworks, groq, huggingface, mistralai, nomic, ollama, openai,
  openrouter, perplexity, qdrant, xai`.

**LangChain JS renamed the directory to `libs/providers/`**
(`https://github.com/langchain-ai/langchainjs/tree/main/libs/providers`),
holding `langchain-anthropic`, `langchain-openai`, `langchain-xai`, etc.
A "partners → providers" rename in the newer of the two codebases is a
strong signal about which word survived.

### The registry: `_BUILTIN_PROVIDERS`

`libs/langchain_v1/langchain/chat_models/base.py`:

```python
_BUILTIN_PROVIDERS: dict[str, tuple[str, str, Callable[..., BaseChatModel]]] = {
    "anthropic": ("langchain_anthropic", "ChatAnthropic", _call),
    "openai": ("langchain_openai", "ChatOpenAI", _call),
    ...
}
"""Registry mapping provider names to their import configuration."""
```

The ID is called a **"provider key"** or **"provider name"** (both
appear in the same file). The 28 values are `anthropic,
anthropic_bedrock, azure_ai, azure_openai, baseten, bedrock,
bedrock_converse, cohere, deepseek, fireworks,
google_anthropic_vertex, google_genai, google_vertexai, groq,
huggingface, ibm, langsmith, litellm, meta, mistralai, nvidia, ollama,
openai, openrouter, perplexity, together, upstage, xai`.

The tuple is `(module_path, class_name, creator_func)` — deliberately
thin. **The registry holds import wiring only, no endpoint, auth or
model knowledge.** It is also explicitly non-exhaustive: *"If a
provider is not in this dict, it can still be used with
`init_chat_model` as long as its integration package is installed."*
`init_chat_model`'s `model_provider` argument docstring: *"Provider of
the model, passed separately instead of as a prefix on `model`.
Equivalent to the prefix form — e.g. `model='claude-sonnet-4-5',
model_provider='anthropic'` behaves the same as
`model='anthropic:claude-sonnet-4-5'`."*

### Trap: "Profile" is taken, and it means per-model capabilities

This is the single most important landmine the survey turned up.

`libs/core/langchain_core/language_models/model_profile.py` declares:

```python
class ModelProfile(TypedDict, total=False):
    """Description of a chat model's capabilities, exposed via `model.profile`."""
```

Its fields are capability flags and limits only — `name, status,
release_date, open_weights, max_input_tokens, max_output_tokens,
text_inputs, image_inputs, pdf_inputs, audio_inputs, video_inputs,
image_url_inputs, image_tool_message, pdf_tool_message,
reasoning_output, reasoning_effort_levels, reasoning_effort_default,
tool_calling, tool_choice, tool_call_streaming, structured_output,
attachment, temperature`. **No pricing, no endpoint, no auth, no base
URL.** The same file defines
`ModelProfileRegistry = dict[str, ModelProfile]` — *"Registry mapping
model identifiers or names to their ModelProfile."* It is surfaced as a
Pydantic field on `BaseChatModel`
(`libs/core/langchain_core/language_models/chat_models.py:366`:
`profile: ModelProfile | None = Field(default=None, exclude=True)`).

Data comes from **models.dev**, generated by the
`langchain-model-profiles` package / `langchain-profiles` CLI
(`https://github.com/langchain-ai/langchain/tree/master/libs/model-profiles`:
*"CLI tool for fetching and updating model capability data from
models.dev for use in LangChain integration packages"*). The generated
artefacts live *inside* each integration package —
`libs/partners/anthropic/langchain_anthropic/data/_profiles.py`
(auto-generated, "DO NOT EDIT THIS FILE MANUALLY") plus
`profile_augmentations.toml` (hand-edited overrides keyed
`provider = "anthropic"`, then `[overrides."claude-opus-4-6"]`).

So in the fastest-moving vocabulary in this space, **"profile" is
unambiguously per-model capability metadata**.

### Does it bundle usage/billing? No.

`UsageMetadata` (`libs/core/langchain_core/messages/ai.py:104`) is a
core, provider-neutral TypedDict of token counts only
(`input_tokens`, `output_tokens`, `total_tokens`,
`input_token_details`, `output_token_details`) — *"a standard
representation of token usage that is consistent across models."* Its
docstring explicitly pushes cost elsewhere: *"LangSmith's
`UsageMetadata` has additional fields to capture cost information used
by the LangSmith platform."*

The only price table LangChain ever shipped —
`MODEL_COST_PER_1K_TOKENS` in
`libs/community/langchain_community/callbacks/openai_info.py`, behind
`get_openai_callback` — lives in `langchain-community`, whose repo
description is now literally *"⚠️ No longer maintained."*

**LangChain's answer: integration package = adapter + capability
profile; pricing is out of scope.**

No use of "kind", "definition", "pack" or "blueprint" was found in any
LangChain source or doc consulted.

---

## 8. Helicone

This is the sharpest prior art in the survey, because Helicone
*explicitly decomposes* the concept into four named nouns — the same
decomposition Iroha is grappling with.

### The four-noun model

`https://docs.helicone.ai/references/provider-integration` (mirrored at
`https://github.com/Helicone/helicone/blob/main/INTEGRATE_PROVIDER_TO_GATEWAY.md`),
titled *"How to integrate a new model provider to the AI Gateway"*:

- **Authors** — *"Companies that create the models (e.g., OpenAI, Anthropic)"*
- **Models** — *"Individual model definitions with pricing and metadata"*
- **Providers** — *"Inference providers that host models (e.g., OpenAI, Vertex AI, DeepInfra, Bedrock)"*
- **Endpoints** — *"Model-provider combinations with deployment configurations"*

Note again the **author vs provider** split, and note that Helicone
also spends **"definition"** on the per-model record — the same choice
models.dev made.

### Code noun: `BaseProvider` subclass, in `packages/cost/models/providers/`

`packages/cost/models/providers/base.ts`:

```ts
export abstract class BaseProvider {
  abstract readonly displayName: string;
  abstract readonly baseUrl: string;
  abstract readonly auth: "api-key" | "oauth" | "aws-signature" | "service_account";
  abstract readonly pricingPages: string[];
  abstract readonly modelPages: string[];
  readonly supportedPlugins: PluginId[] = [];
  abstract buildUrl(endpoint: Endpoint, requestParams: RequestParams): string;
  buildModelId(...); authenticate(...); buildRequestBody(...); buildErrorMessage(...);
}
```

That abstract surface — display name, base URL, auth scheme, URL
construction, body transform, error message construction — is almost
exactly Iroha's Provider Template + Inference Adapter merged into one
class. Concrete subclasses are one file each in
`packages/cost/models/providers/`: `anthropic.ts, azure.ts, baseten.ts,
bedrock.ts, canopywave.ts, cerebras.ts, chutes.ts, deepinfra.ts,
deepseek.ts, fireworks.ts, google.ts, groq.ts, helicone.ts, mistral.ts,
nebius.ts, novita.ts, openai.ts, openrouter.ts, perplexity.ts,
vertex.ts, xai.ts`.

### The ID: `ModelProviderName`

`packages/cost/models/providers/index.ts`:

```ts
export const providers = {
  anthropic: new AnthropicProvider(),
  "google-ai-studio": new GoogleProvider(),
  ...
} as const;
export type ModelProviderName = keyof typeof providers;
```

There is also a compound ID in `packages/cost/models/registry-types.ts`:

```ts
export type EndpointId = `${ModelName}:${ModelProviderName}:${DeploymentName}`;
```

and a user-facing routing syntax `model/provider` or
`model/provider/deployment-id` — `"gpt-4o-mini/openai"`,
`"gpt-4o/azure/eu-frankfurt-deployment"`, with fallback chains
`"model/p1,model/p2"` and exclusion `"!provider,model"`
(`https://docs.helicone.ai/gateway/provider-routing`).

### Does it bundle usage/billing? Yes — and it splits it out by name.

The whole registry lives inside a package called **`packages/cost`**.
`packages/cost/models/types.ts` defines `ModelPricing` (`input`,
`output`, `threshold`, `cacheMultipliers.{cachedInput,write5m,write1h}`,
`cacheStoragePerHour`, `thinking`, `request`, per-modality
`image/audio/video/file`, `web_search`), carried on
`EndpointConfig.pricing?: ModelPricing[]`. Cost arithmetic is in
`packages/cost/models/calculate-cost.ts` and `packages/cost/costCalc.ts`.
Pricing sits on the **model/endpoint**, not on the provider class.

Iroha's Usage Adapter has a direct Helicone analogue with a *different*
name: `packages/cost/usage/` contains `IUsageProcessor.ts`,
`getUsageProcessor.ts`, and per-vendor
`anthropicUsageProcessor.ts`, `bedrockUsageProcessor.ts`,
`googleUsageProcessor.ts`, `openAIUsageProcessor.ts`,
`openRouterUsageProcessor.ts`, `vertexUsageProcessor.ts`,
`xaiUsageProcessor.ts`, plus `mapModelUsageToOpenAI.ts`. So Helicone's
answer to "optional usage adapter" is a named **`UsageProcessor`
sibling**, not a method on the provider class.

### The Rust AI Gateway — a second, thinner vocabulary

`https://github.com/Helicone/ai-gateway`:

- `src/types/provider.rs` declares **two** enums: `ModelProvider` (the
  *author* — `OpenAI, Anthropic, Amazon, Deepseek, Google`) and
  **`InferenceProvider`** (the *host* — `OpenAI, Anthropic, Bedrock,
  Ollama, GoogleGemini`, plus an open `Named(CompactString)` variant).
- The provider registry is a YAML file compiled into the binary:
  `config/embedded/providers.yaml`, loaded with `include_str!` in
  `src/config/providers.rs`. Each entry *is* the built-in-knowledge
  bundle:

  ```yaml
  anthropic:
    models: ["claude-opus-4-0", "claude-sonnet-4-0", ...]
    base-url: https://api.anthropic.com/
    version: "2023-06-01"
  ```

  Rust types:
  `GlobalProviderConfig { models: IndexSet<ModelId>, base_url: Url, version: Option<String> }`
  and `ProvidersConfig(IndexMap<InferenceProvider, GlobalProviderConfig>)`
  — doc comment: *"Map of *ALL* supported providers."* The
  deserializer's `expecting()` string is *"a map of inference providers
  to their configuration."*
- The transform layer is **not** named after the provider: it is
  `src/endpoints/` with an `Endpoint` trait (`const PATH`,
  `RequestBody`, `ResponseBody`, `ErrorResponseBody`,
  `StreamResponseBody`), an `ApiEndpoint` enum,
  `ApiEndpoint::mapped(source_endpoint, target_provider)` and
  `endpoints/mappings.rs`, with sub-modules `anthropic/`, `bedrock/`,
  `google/`, `ollama/`, `openai/`. (The TS monorepo separately has
  `packages/llm-mapper/`.)
- No cost logic in the Rust gateway — it stays in the TypeScript
  `packages/cost`.

---

## 9. Kong AI Gateway, Envoy AI Gateway, `llm`

### Kong — code says **driver**, docs say **provider**

Kong's per-vendor modules are Lua files under `kong/llm/drivers/`,
confirmed present on `master`: `openai.lua`, `anthropic.lua`,
`cohere.lua`, `azure.lua`, `llama2.lua`, `mistral.lua`, `gemini.lua`,
`bedrock.lua`, `huggingface.lua` (all fetch 200 from
`https://raw.githubusercontent.com/Kong/kong/master/kong/llm/drivers/`).
`kong/llm/init.lua:1` opens with
`local ai_shared = require("kong.llm.drivers.shared")`, and each module
declares its own identity constant —
`kong/llm/drivers/anthropic.lua:14`:

```lua
local DRIVER_NAME = "anthropic"
```

The user-facing vocabulary is different: the `ai-proxy` plugin config
field is **`config.model.provider`**
(`https://developer.konghq.com/plugins/ai-proxy/`), and the docs say
"provider" throughout — *"supported AI providers"*,
*"provider-specific details"*. Accepted values include OpenAI, Azure
OpenAI, Amazon Bedrock, Anthropic, Gemini, Vertex AI, Cohere, Mistral,
Hugging Face, Llama, xAI, Alibaba Cloud DashScope, Cerebras, DeepSeek,
Ollama, Databricks and vLLM. The plugin does record usage: *"Recording
of usage statistics of the configured LLM provider and model into your
selected Kong log plugin output"*, with cost calculation in the native
formats.

**"Driver" is therefore live prior art for the internal module noun** —
but only Kong uses it, and it collides with the database/OS sense of
the word.

### Envoy AI Gateway — the noun is split across two CRDs

Docs prose says "provider":
`https://aigateway.envoyproxy.io/docs/capabilities/llm-integrations/supported-providers`
is titled **"Supported AI Providers"** and states *"Support of a
provider means two things: the API schema support and the
Authentication support. The former can be configured in the
`AIServiceBackend` resource's `schema` field"*, the latter in
`BackendSecurityPolicy`.

So Envoy has no single "provider module" object at all. It has:

- **`AIServiceBackend`** — the upstream record;
- **`VersionedAPISchema`** — *"defines the API schema of either
  AIGatewayRoute (the input) or AIServiceBackend (the output)"*, with
  an inner `APISchema` name field (values include `OpenAI`,
  `AWSBedrock`, `AzureOpenAI`, `AnthropicOnVertexAI`, …) and a `prefix`
  field for OpenAI-compatible upstreams on non-standard paths such as
  Gemini's `/v1beta/openai` or Cohere's `/compatibility/v1`
  (`https://aigateway.envoyproxy.io/docs/api/`);
- **`BackendSecurityPolicy`** — the auth half.

Being a Kubernetes CRD project, every one of these objects is addressed
by a literal `kind:` field. See §10 for why that kills "Provider Kind."

### Simon Willison's `llm` — **plugin**

`https://llm.datasette.io/en/stable/plugins/index.html`: *"LLM plugins
can enhance LLM by making alternative Large Language Models available,
either via API or by running the models locally on your machine."* The
extension hook for a vendor is **`register_models(register,
model_aliases)`**. Packages are `llm-anthropic`, `llm-gemini`, etc. The
docs do not describe pricing or quota as part of a plugin.

"Plugin" is the right word for a *dynamically loaded, third-party,
out-of-tree* extension. It is the wrong word for Iroha's case, where
the bundles are first-party, in-tree, reviewed TypeScript (ADR 0004
explicitly rejected runtime plugin uploads).

---

## 10. Outside the gateway space — where the candidate nouns already live

These are not LLM gateways, but they set the reader's expectations for
the words, so they matter for the naming decision.

### models.dev — the closest structural match to Iroha's bundle

`sst/models.dev` (used by opencode) stores, per vendor, a directory
`providers/<provider-id>/` containing `provider.toml`, `logo.svg`, and
`models/*.toml`
(`https://github.com/sst/models.dev/blob/dev/README.md`). The
`provider.toml` is *exactly* Iroha's Provider Template:

```toml
name = "Provider Name"
npm = "@ai-sdk/provider"          # AI SDK Package name
env = ["PROVIDER_API_KEY"]        # Environment Variable keys used for auth
doc = "https://example.com/docs/models"
```

with `api = "https://api.example.com/v1"` required when
`npm = "@ai-sdk/openai-compatible"`. Per-model files carry `[cost]`
(`input`, `output`, `reasoning`, `cache_read`, `cache_write`),
`[limit]`, `[modalities]`.

Two naming decisions worth stealing:

- The concept is called **Provider**, its ID is called **Provider ID**
  (`curl https://models.dev/logos/{provider}.svg` — *"Replace
  `{provider}` with the **Provider ID**"*).
- The per-model TOML is called a **"Model Definition"** (README section
  heading *"#### 3. Add a Model Definition"*). So in the one project
  that most closely mirrors Iroha's data layout, **"definition" is
  already spent on the per-model record**, not the per-provider one.
- models.dev also splits provider-agnostic model facts (`models/`) from
  provider-specific serving facts (`providers/<id>/models/`), joined by
  a `base_model` key — the same author/provider split OpenRouter makes.
- On the website, models.dev goes further and calls the model *creator*
  a **"Lab"**, reserving "provider" for the serving API
  (`https://models.dev/`).

### Microsoft Semantic Kernel — "connector"

Per-vendor packages are named `Microsoft.SemanticKernel.Connectors.OpenAI`,
`…Connectors.AzureOpenAI`, `…Connectors.MistralAI`, `…Connectors.Google`,
`…Connectors.HuggingFace`, `…Connectors.Ollama`, `…Connectors.Amazon`,
`…Connectors.Onnx`, with the Python mirror
`semantic_kernel.connectors.ai.<vendor>`
(`https://learn.microsoft.com/en-us/semantic-kernel/concepts/ai-services/chat-completion/`).
Prose consistently says *"the Mistral chat completion **connector** is
currently experimental"*, *"you can use the OpenAI chat completion
connector"*. **"Connector" is Microsoft's word for this exact concept**
— which is a reason to avoid it unless you want to be read as
Semantic-Kernel-flavoured.

### Terraform — "provider" as a plugin bundling one upstream API

`https://developer.hashicorp.com/terraform/language/providers`:
*"Terraform relies on plugins called providers to interact with cloud
providers, SaaS providers, and other APIs"*; *"Each provider adds a set
of resource types and/or data sources that Terraform can manage."*
This is the strongest general-software precedent that "provider" =
"the module that knows one upstream API", and it predates the LLM
space by a decade.

### Kubernetes — `kind` is a reserved word

Every Kubernetes object carries a top-level `kind:` field naming its
*resource type*, and the extension mechanism is literally called a
**Custom Resource Definition**. Any gateway that ships CRDs inherits
both words. Envoy AI Gateway's upstream record is
`kind: AIServiceBackend`
(`https://aigateway.envoyproxy.io/docs/capabilities/llm-integrations/supported-providers`),
and kgateway/agentgateway follow the same pattern. In a
Kubernetes-adjacent reader's head, "Provider Kind" reads as *"the
`kind:` string of a Provider resource"* — i.e. the literal token
`"Provider"` — not as "a type of provider."

### StackStorm — "pack" as the unit of one-external-system integration

`https://docs.stackstorm.com/packs.html`: *"A 'pack' is the unit of
deployment for integrations and automations that extend StackStorm."*
Packs are *"typically organized around service or product boundaries
(AWS, Docker, Sensu, etc.)"* and contain Actions, Workflows, Rules,
Sensors and Aliases. StackStorm distinguishes **integration packs**
(*"extend StackStorm to connect with external systems"*) from
**automation packs**. HashiCorp's Nomad Pack
(`https://developer.hashicorp.com/nomad/tools/nomad-pack`) uses the
word for a templated deployment bundle.

So "pack" already has a precise, *helpful* meaning in operations
tooling: **a bundle of everything needed to integrate one external
system**. That is precisely Iroha's concept — and no LLM gateway has
claimed the word.

---

## 11. Summary table

| Project | Code noun (exact identifier) | Docs noun | ID called | Bundles usage/billing? |
|---|---|---|---|---|
| **LiteLLM** | `<Provider>Config : BaseConfig` + `BaseLLMModelInfo`, registered in `ProviderConfigManager` (`litellm/utils.py:7777`); dir `litellm/llms/<provider>/` | **provider** ("Providers"; "Integrate as a Model Provider") | `LlmProviders` enum member / `custom_llm_provider` string | Partly — per-provider `cost_calculation.py`, central `model_prices_and_context_window.json`; no quota reader |
| **Bifrost** | `schemas.Provider` interface (`core/schemas/provider.go:631`); dir `core/providers/<name>/`; `createBaseProvider` switch (`core/bifrost.go:4384`) | **provider** ("Supported providers") | `schemas.ModelProvider` / "provider key" (`GetProviderKey()`) | No — pricing is the central **Model Catalog**; budgets are `plugins/governance` |
| **Portkey** | `ProviderConfigs` object per dir `src/providers/<name>/index.ts`; registry `const Providers` (`src/providers/index.ts:78`) | **provider** (nav section: "Integrations") | slug constant in `src/globals.ts` (`ANTHROPIC = 'anthropic'`) | No — token reshaping only |
| **OpenRouter** | n/a (hosted) | **provider** (serving host), distinct from **author**; onboarding page "Provider Integration" | **provider slug**; `tag` in the endpoints API | **Yes** — `pricing` sits on each endpoint object |
| **Cloudflare AI Gateway** | n/a (hosted) | **provider** ("Provider Native"; "Custom Providers") | `slug` / URL path segment | No — cost is a central estimate + "Custom Costs" override |
| **Vercel AI SDK** | `ProviderV4` (`packages/provider/src/provider/v4/provider-v4.ts`); pkg `@ai-sdk/<vendor>` | **provider**, "provider package"; repo skill says "adapter pattern" | `provider: string` on the *model*, not the provider | No — usage is token counts only |
| **LangChain (py)** | `_BUILTIN_PROVIDERS` dict (`libs/langchain_v1/langchain/chat_models/base.py`); pkg `langchain-<vendor>` in `libs/partners/` | **integration package**; the vendor is a **provider**; legacy "partner package" | "provider key"/"provider name"; `model_provider=` | No — cost only in deprecated `langchain-community` |
| **LangChain (js)** | same, dir renamed **`libs/providers/`** | same | same | No |
| **Helicone (TS)** | `BaseProvider` abstract class (`packages/cost/models/providers/base.ts`); registry `providers` const | **provider**; docs also name **Authors / Models / Providers / Endpoints** | `ModelProviderName` (`keyof typeof providers`); `EndpointId` = `` `${ModelName}:${ModelProviderName}:${DeploymentName}` `` | **Yes** — whole tree is `packages/cost`; usage split into `IUsageProcessor` |
| **Helicone (Rust)** | `InferenceProvider` enum + `config/embedded/providers.yaml`; transforms in `src/endpoints/` | **inference provider** | `InferenceProvider` | No |
| **Kong AI Gateway** | `kong/llm/drivers/<name>.lua`, `local DRIVER_NAME = "anthropic"` | **provider** (`config.model.provider`) | provider string in plugin config | Records usage stats + cost calculation in the plugin |
| **Envoy AI Gateway** | `AIServiceBackend` CRD + `VersionedAPISchema`/`APISchema` + `BackendSecurityPolicy` | **provider** ("Supported AI Providers") | k8s object name; `schema.name` for the API shape | No |
| **Semantic Kernel** | `Microsoft.SemanticKernel.Connectors.<Vendor>` / `semantic_kernel.connectors.ai.<vendor>` | **connector** | package/namespace name | No |
| **models.dev** | `providers/<id>/provider.toml` + `providers/<id>/models/*.toml` | **provider**; model creator is a **Lab**; per-model file is a **"Model Definition"** | **Provider ID** | **Yes** — `[cost]` per model |
| **Terraform** (non-LLM) | provider plugin | **provider** ("plugins called providers") | source address | n/a |
| **StackStorm** (non-LLM) | pack directory | **pack** ("the unit of deployment for integrations… organized around service or product boundaries") | pack ref | n/a |
| **`llm` (Datasette)** | plugin implementing `register_models()` | **plugin** | plugin package name | No |

---

## 12. Which candidate nouns are dangerous

### AVOID: "Kind"

- **Kubernetes owns it absolutely.** Every k8s object has a top-level
  `kind:` field naming its resource type, and the extension mechanism
  is a *Custom Resource **Definition***. Envoy AI Gateway
  (`AIServiceBackend`, `BackendSecurityPolicy`,
  `https://aigateway.envoyproxy.io/docs/api/`) and the other CRD-based
  AI gateways all inherit this. To anyone who has written YAML this
  decade, "Provider Kind" parses as *"the `kind:` string of a Provider
  resource"* — i.e. the literal token `"Provider"` — not "a type of
  provider."
- In Go, Rust and TypeScript, `kind` is also the conventional
  discriminant field name for tagged unions. Iroha already uses this
  pattern (`ProviderFailure` is discriminated on `code`; adapters
  discriminate on typed categories). Introducing an entity called
  "Kind" invites confusion with every discriminant in the codebase.
- No project in this survey uses "kind" for a provider module.

### AVOID: "Definition"

- **The LLM APIs themselves use it for tool schemas.** Anthropic's own
  docs say *"Add `strict: true` to your custom **tool definitions**"*
  and ship a page section on *"optional **tool definition**
  properties"*
  (`https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview`,
  `.../tool-reference`). Iroha already touches this vocabulary in its
  Anthropic tool-name sanitisation work.
- **Both projects with a data layout like Iroha's already spent
  "definition" on the per-model record.** models.dev's README section
  is literally *"#### 3. Add a Model Definition"*; Helicone's
  integration guide defines **Models** as *"Individual model
  definitions with pricing and metadata."* If Iroha calls the provider
  bundle a "Provider Definition", the natural next question is "so
  what's a Model Definition?" and the answer conflicts with the two
  nearest neighbours.
- Kubernetes CRD ("Custom Resource **Definition**") pulls the word
  toward "the schema of a type", not "an instance of built-in
  knowledge".

### AVOID: "Profile" (not a stated candidate, but rule it out)

Not one of the three stated candidates, but worth ruling out
explicitly because it is the obvious fourth suggestion.

**LangChain has claimed it, precisely and recently.** `ModelProfile`
(`libs/core/langchain_core/language_models/model_profile.py`) is
*"Description of a chat model's capabilities, exposed via
`model.profile`"* — capability flags and token limits, **per model**,
sourced from models.dev, generated by the `langchain-model-profiles`
package into each integration package's `data/_profiles.py`. There is
also `ModelProfileRegistry`. Using "Provider Profile" for a
*provider-level bundle including auth and endpoints* would collide
head-on with the fastest-spreading new term in the ecosystem.

### CAUTION: "Blueprint" — free, but empty

No project in the survey uses it. That is both the appeal and the
problem: it carries no prior meaning, so it teaches the reader nothing,
and it reads as marketing rather than architecture. It also implies
"a plan you build from once", which understates that Iroha's bundle is
live typed behaviour executing on every request.

### CAUTION: "Adapter" — already spent, inside Iroha and outside

Iroha already uses **Inference Adapter** and **Usage Adapter** as the
*components* of the bundle (`docs/adapters.md`, ADR 0004). Reusing
"adapter" for the container as well would make "the adapter contains
two adapters" a sentence Iroha has to write. Externally, the Vercel AI
SDK has spent "Adapters" on its LangChain/LlamaIndex stream-conversion
docs section, and Vercel's own authoring guide describes the provider
layer as *following* the adapter pattern rather than being called one.

### CAUTION: "Connector" — Microsoft's word

`Microsoft.SemanticKernel.Connectors.OpenAI` /
`semantic_kernel.connectors.ai.<vendor>` means exactly this concept
(`https://learn.microsoft.com/en-us/semantic-kernel/concepts/ai-services/chat-completion/`).
Not dangerous in the sense of meaning something *else*, but it will
read as Semantic-Kernel-flavoured, and it is unused by every gateway
studied.

### CAUTION: "Driver" — Kong's word, plus 40 years of baggage

Kong's per-vendor Lua modules are `kong/llm/drivers/<name>.lua` with
`local DRIVER_NAME = "anthropic"` — so "driver" is live prior art for
exactly this. But Kong's *own docs* never use it (they say
`config.model.provider`), and the word drags in device drivers, JDBC
drivers and ODBC. It also implies pure protocol translation, which
would make bundling the Usage Adapter feel wrong.

### CAUTION: "Template" — Iroha's current word, weakly held

Portkey ships versioned **Prompt Templates** as a product object
(`https://portkey.ai/docs/product/prompt-engineering-studio/prompt-library`),
and "template" means "prompt template" by default across the LLM
tooling ecosystem. Iroha's "Provider Template" survives on the strength
of its qualifier. It is also *narrower* than the concept being named
here — in `src/providers/templates.ts` a Provider Template is
explicitly the data-only half that *points at* an adapter, so it cannot
be promoted to name the whole bundle without redefining it.

### SAFE: "Pack" — free in this space, and already means the right thing elsewhere

- **No LLM gateway, SDK or hosted product in this survey uses "pack"
  for anything.** Searches across LiteLLM, Bifrost, Portkey,
  OpenRouter, Cloudflare, Vercel AI SDK, LangChain, Helicone, Kong,
  Envoy AI Gateway and `llm` turned up zero uses.
- **In operations tooling it already means exactly this.** StackStorm:
  *"A 'pack' is the unit of deployment for integrations and automations
  that extend StackStorm"*, *"typically organized around service or
  product boundaries (AWS, Docker, Sensu, etc.)"*, containing Actions,
  Workflows, Rules, Sensors and Aliases
  (`https://docs.stackstorm.com/packs.html`). That is structurally
  identical to Iroha's *Template + Inference Adapter + Usage Adapter*.
  StackStorm even distinguishes **integration packs** from *automation*
  packs.
- HashiCorp's **Nomad Pack**
  (`https://developer.hashicorp.com/nomad/tools/nomad-pack`) and
  Cloud Native Buildpacks reinforce the "pack = a bundle you install as
  one unit" reading without conflicting.
- Risk to note: "pack" leans toward *installable / third-party*, which
  is not quite true of Iroha (ADR 0004 rejects runtime plugin uploads;
  bundles are first-party, in-tree, reviewed TypeScript). "Provider
  Pack" therefore over-promises extensibility slightly. Mitigate by
  documenting in the same breath that packs are compiled in, not
  uploaded — the same way LiteLLM keeps `litellm/llms/<provider>/`
  in-tree while calling the seam a "provider".

### Recommendation

**`Provider Pack`** is the safest of the three candidates:

1. It is the only one with **zero conflicting use** in AI gateways,
   LLM SDKs, or the LLM APIs themselves.
2. Its nearest prior meaning (StackStorm) is *the same shape as Iroha's
   concept* — a bundle of everything needed to integrate one external
   system — so it teaches rather than misleads.
3. It composes cleanly with the words Iroha has already spent:
   *"A Provider Pack contains a Provider Template, an Inference Adapter,
   and a Usage Adapter."* Neither "Kind" nor "Definition" reads
   naturally in that sentence, because both suggest schema rather than
   contents.
4. It does not collide with **Provider**, which Iroha already uses for
   the Owner-created instance (ADR 0006, ADR 0017). This matters more
   than it looks: every project in the survey uses "provider" for the
   *vendor*, and Iroha uses it for the *configured connection*.
   Whatever the bundle is called, it must not be a bare noun that
   readers will collapse back into "provider".

Two secondary recommendations from the survey, independent of the name:

- **Steal the author/provider split.** OpenRouter
  (`{author}/{slug}` model IDs), Helicone (*"Authors — companies that
  create the models"* vs *"Providers — inference providers that host
  models"*), Helicone's Rust gateway (`ModelProvider` vs
  `InferenceProvider`), and models.dev ("Lab" vs "Provider") have all
  independently converged on needing two words. Iroha's Anthropic
  Provider Template served by Z.ai, DashScope or Bedrock will hit the
  same ambiguity.
- **Do not put pricing in the pack.** Every project that tried it moved
  it out: LiteLLM to a central JSON, Bifrost to the Model Catalog,
  LangChain to LangSmith, Cloudflare to observability. Only OpenRouter
  and Helicone keep price with the provider record, and both are
  billing products first. Iroha's Usage Adapter — reading *the vendor's
  own authoritative balance* rather than multiplying tokens by a price
  table — has no equivalent in any project surveyed, and is the one
  genuinely novel member of the bundle.
