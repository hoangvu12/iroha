# Provider behavior lives in typed adapters

Common OpenAI-compatible providers are added through data-only Provider Templates, while custom authentication, failure classification, capability behavior, idempotency, and entitlement polling live in reviewed TypeScript Inference and Usage Adapters. Runtime script/plugin uploads were rejected because they would turn the management UI into a remote-code-execution surface and replace a typed extension seam with an unbounded configuration language.

