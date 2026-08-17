# 01 — Green the suite, clean the repo, and merge the Provider Pack work to main

**What to build:** `bun test` currently reports 25 failures across 1141 tests. All 25 come from two untracked work-in-progress files, `test/http/inference-anthropic-tools.test.ts` and `test/http/inference-anthropic-streaming.test.ts`, and every one is the same error: their `createAnthropicConnection` helper posts a Provider without a `handle`, which ADR-0017 made required. The green suites already do it correctly (`test/http/providers.test.ts:77`). No committed work is red.

Fix the helper in both files, clean up two pieces of repo hygiene, then land the branch. `stdout.log` and `stderr.log` are runtime logs tracked in git and modified on every run, and `.gitignore` covers neither them nor `.scratch/`.

`feat/provider-packs` is six commits ahead of `main` and zero behind, with no remote configured, so the merge is a local fast-forward that publishes nothing.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Both Anthropic test helpers post a `handle`, following the naming convention in `test/http/providers.test.ts`.
- [ ] `bun test` reports zero failures.
- [ ] `bun run typecheck` passes.
- [ ] `stdout.log` and `stderr.log` are untracked via `git rm --cached`, and `.gitignore` covers `*.log` and `.scratch/`.
- [ ] The two `.scratch/` files currently tracked — `.scratch/iroha-v1/spec.md` and `.scratch/anthropic-support/issues/03-anthropic-tools-and-tool-name-sanitisation.md` — are also untracked. A `.gitignore` entry does not untrack a file already in the index, so leaving them would keep two of the tracker's files versioned while the rest are not.
- [ ] The working tree's source changes, new tests, six new ADRs, five research documents and `scripts/` are committed to `feat/provider-packs`. `.scratch/` is not.
- [ ] `main` is fast-forwarded to `feat/provider-packs`.
- [ ] A `feat/optimistic-updates` branch exists off the merged `main`.
