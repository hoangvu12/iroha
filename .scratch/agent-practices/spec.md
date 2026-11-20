# Agent practices from pstack

Status: open

Two practices from `docs/research/pstack-agent-practices.md` ("What we could copy", items 1, 4 and 5), chosen by the Owner:

1. **Rules as checks, not prose** (ticket 01). Every rule in `docs/agents/architecture.md` "Rules everyone follows" that a program can check becomes a Go test that fails with a message naming the fix. The prose shrinks to what still needs judgement.
2. **A verifier that runs the change** (ticket 02). A launcher that starts a real Iroha with fake upstreams and demo data in one command, and a project skill `verify-iroha` that tells an agent that did not write a change how to launch, drive and collect evidence, ending in `PASS`, `PASS+NOTES` or `FAIL` in the ticket's `## Comments`.

After both land, the orchestrator updates `AGENTS.md` and `docs/agents/issue-tracker.md` so every ticket's "Done when" includes a verifier's verdict.

Out of scope: the blanket comment ban, stacked PRs, CI.
