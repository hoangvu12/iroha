# Agent instructions

## Agent skills

### Issue tracker

Issues and specs are tracked as Local Markdown under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Domain docs

This is a single-context repository. See `docs/agents/domain.md`.

### Architecture

Read `docs/agents/architecture.md` before changing code: package map, how to add a route, a migration and a log event kind, and how to test with `internal/testkit`.

## Background

This branch is Iroha v2, a from-scratch rewrite of v1 (branch `main`, a Bun/TypeScript app). The v2 spec is `.scratch/v2-gateway/spec.md`. Research that shaped it lives in `docs/research/`; `docs/research/v1-case-catalog.md` lists every behaviour v1 handled and is the conformance checklist for v2.
