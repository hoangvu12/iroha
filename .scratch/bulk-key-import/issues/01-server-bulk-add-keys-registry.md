# 01 — `bulkAddKeys` on `ProviderRegistry`

**What to build:** A new `bulkAddKeys(providerId, entries)` method on `ProviderRegistry` (`src/providers/provider-registry.ts`) that inserts each entry in its own transaction, audits each successful insert as `key.created`, and probes the connection's unverified keys in a single pass at the end. The method returns per-entry results so the HTTP layer can build the partial-success response.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] A new `bulkAddKeys(providerId, input: { keys: readonly { upstreamKey: unknown; baseUrl?: unknown }[] })` method exists on `ProviderRegistry`.
- [x] The method short-circuits with `provider_not_found` / `provider_archived` before doing any per-entry work, mirroring `addKey`'s guard pattern at `src/providers/provider-registry.ts:904-906`.
- [x] Per-entry validation runs through the same `upstreamKeyProblems` + `readKeyBaseUrl` helpers `addKey` uses (no duplicate validation rules).
- [x] Each entry that passes validation is inserted in its own `database.transaction(...)` block, identical to the transaction shape at `src/providers/provider-registry.ts:916-949`.
- [x] Each successful insert audits `key.created` with `{ providerId, keyId, baseUrlInherited? }`, matching `addKey`'s audit detail shape.
- [x] Per-entry failures are captured as `{ index, problems }` and recorded in the `failed` array; subsequent entries still proceed (partial success).
- [x] After the loop completes, `#probeConnectionKeys(providerId)` is invoked exactly once, regardless of how many keys were inserted (mirroring `create`'s single-probe pattern at `src/providers/provider-registry.ts:429`).
- [x] The method returns `{ ok: true, value: { added: readonly { index: number; keyId: string }[]; failed: readonly { index: number; problems: readonly FieldProblem[] }[] } }` on success.
- [x] The result type lives alongside `ProviderResult<T>` in `src/providers/provider-registry.ts` and is exported.
- [x] No per-entry `accountId` / `allowedModels` / `deniedModels` plumbing: bulk-imported keys are inserted with all three columns `null`, matching the spec's "configure later" decision.
- [x] Registry-level tests in `test/providers/provider-registry.test.ts` cover: empty list (returns `{added: [], failed: []}`), all-valid batch, mixed valid/invalid batch, archived provider short-circuit, missing provider short-circuit, and the single-probe invariant (assert `#probeConnectionKeys` was called exactly once for a 5-key batch — use a spy on the private method or a probe-call counter).
