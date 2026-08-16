# Provider failure classification and bounded retries

Status: In progress

## Goal

Keep Provider-specific failure meaning in typed Inference Adapters while the Gateway owns bounded retry orchestration.

## Decisions

- An Inference Adapter classifies an upstream failure into a typed failure kind, Capacity Scope, retry action, and optional retry timing.
- A generic, unrecognized HTTP 402 excludes the failed Upstream Key for this request and tries at most one alternate. It does not durably mark capacity exhausted.
- Recognized Provider billing failures may durably exhaust only the Capacity Scope supported by authoritative Provider evidence.
- Ambiguous transport replay remains separate from HTTP-status retry. It defaults off, may be enabled by the Owner, retries the same key at most once before any response is exposed, stays within the Provider attempt/time budget, and reuses a stable adapter-supported idempotency value.
- Owner copy must disclose duplicate-request/charge risk; generic Providers do not promise exactly-once inference.

## Test seam

The assembled Gateway HTTP interface in `test/http/inference-retries.test.ts`. UI behavior remains covered at the HTTP seam per `docs/agents/ui-testing.md`.

## Research

See `.scratch/retry-policy-research/findings.md`.

## Out of scope

- The separate request-history parent-row finalization defect.
- MiniMax durable billing classification until an authoritative error-body contract is located.
