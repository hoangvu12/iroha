# Agent instructions

## Agent skills

### Issue tracker

Issues and specs are tracked as Local Markdown under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Domain docs

This is a single-context repository. See `docs/agents/domain.md`.

### Verification

A ticket is done only when an agent that did not write it has run the change with the `verify-iroha` skill and left a verdict in the ticket. See "Verification" in `docs/agents/issue-tracker.md`. `go run ./cmd/iroha-dev` starts a local Iroha with fake upstreams and demo data.

### Architecture

Read `docs/agents/architecture.md` before changing code: package map, how to add a route, a migration and a log event kind, and how to test with `internal/testkit`.

### UI SDK (the web UI's components)

Before using ui-sdk (`@ui-sdk/react`, `@ui-sdk/core`, pinned to one exact version in `web/package.json`), follow the ui-sdk skill if it's installed, and read `web/node_modules/@ui-sdk/react/docs/llms.txt`, then only the component pages under `docs/components/` your task needs. To build a new component, also search `web/node_modules/@ui-sdk/react/docs/core.md` by heading (it's over 300 KB) and read `rendering.md` next to it. The skill isn't installed here: read it, don't install it, from `web/node_modules/@ui-sdk/core/skills/ui-sdk/` (`SKILL.md` and `references/`; the same as `vercel-labs/ui` at commit `8b452a3aa1`, `packages/core/skills/ui-sdk/`), and follow its "Rules for every path".

## Background

This is Iroha v2, a from-scratch rewrite of v1 (a Bun/TypeScript app, retired; its last state is the tag `v1-final`). `main` is v2. The v2 spec is `.scratch/v2-gateway/spec.md`. Research that shaped it lives in `docs/research/`; `docs/research/v1-case-catalog.md` lists every behaviour v1 handled and is the conformance checklist for v2.
