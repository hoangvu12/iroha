# Provider adapters

## Extension model

Iroha separates data-only Provider Templates from typed behavior.

- A **Provider Template** supplies setup defaults such as display name, base URL, authentication choice, known model hints, and default capabilities.
- An **Inference Adapter** owns authentication injection, endpoint behavior, capability defaults, safe transformations, structured failure classification, and declared idempotency support.
- A **Usage Adapter** reads authoritative balance, subscription, coding-plan usage, or reset information when a provider exposes a documented API.

Most OpenAI-compatible providers should need only a template backed by the Generic OpenAI Inference Adapter. Do not add provider-specific code merely to prefill a URL.

## Generic OpenAI adapter

The generic adapter:

- forwards supported Chat Completions, Responses, and Models operations;
- preserves exact upstream model IDs and unknown JSON fields;
- supports configurable bearer or header-based authentication and encrypted static headers;
- uses conservative HTTP failure defaults;
- reports usage visibility as `reactive_only`;
- never claims an authoritative remaining balance;
- allows Owner capability and model overrides.

Arbitrary executable authentication or response scripts are not accepted through configuration.

## Inference Adapter contract

An adapter should declare, in typed code:

- stable adapter ID and supported endpoints;
- authentication construction;
- endpoint construction and safe redirect behavior;
- connection and per-model capability defaults;
- request/response transformation only where required;
- failure normalization as category, Capacity Scope, retryability, retry time, and confidence;
- whether a denial is key-, account-, model-, connection-, or provider-scoped;
- supported idempotency headers and generation safety;
- a low-cost validation operation, when available.

The generic fallback must remain conservative. In particular, an unknown `403` does not globally invalidate a key, and an unknown `429` does not prove another key has independent capacity.

## Usage Adapter contract

A Usage Adapter should declare:

- endpoint and authentication scheme;
- whether inference credentials have permission to call it;
- units and windows;
- key, account, subscription, model, or provider scope;
- refresh interval and upstream polling constraints;
- authoritative versus estimated status;
- balance/usage/reset parsing from structured provider responses;
- recovery evidence for Exhausted or Cooling Down state.

The normalized result must distinguish Unknown from confirmed zero. Retain the last successful result with its timestamp and display polling failures separately.

Expected entitlement shapes include credit balance and subscription/coding-plan usage, but the set remains open-ended because providers expose different commercial models.

## Adding a provider

1. Confirm that its inference surface is actually OpenAI-compatible.
2. Add a data-only Provider Template using the generic adapter where possible.
3. Add mock-upstream fixtures for authentication, models, success, streaming, and representative errors.
4. Add an Inference Adapter only for behavior the generic contract cannot express safely.
5. Add a Usage Adapter only against a documented provider API.
6. Document capability and usage gaps honestly.
7. Never include credentials or depend on nyanis-discovered keys.

All required automated tests use deterministic mocks. Real-provider credentials and live-provider test suites are outside the version-one contract.

