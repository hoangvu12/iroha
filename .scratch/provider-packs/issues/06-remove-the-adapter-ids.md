# 06 — Remove the adapter ids

**What to build:** With every brand declared as a Provider Pack holding its adapter factories directly, the machinery that rejoined a Provider Template to its adapters by string is dead weight. Delete it.

That machinery includes the adapter-id constants, their re-exports from the inference, usage and providers modules, the Adapter Registry's per-adapter override options, and the Adapter Registry's construction-time validation that a Provider Template names a registered adapter. That validation is removed rather than reimplemented: a Pack cannot name an adapter it does not hold, so the error it caught becomes unrepresentable.

The test suites that enumerate Providers by hand — the Provider Template assertions, the assembled Provider Template route assertions, and the Adapter Registry construction assertions — are rewritten to iterate the Pack list instead of branching per brand.

This is the contract step. Adding a typed Provider afterwards costs one Pack module, one line in the Pack list, and the adapter behaviour the upstream genuinely needs.

**Blocked by:** 04, 05.

**Status:** ready-for-agent

- [ ] A Provider Pack references its Inference Adapter and Usage Adapter factories directly. No adapter is reached by string id.
- [ ] The adapter-id constants and their re-exports are deleted. No module exports them.
- [ ] The Adapter Registry's per-adapter override options are deleted, replaced by the mechanism from ticket 05.
- [ ] The Adapter Registry's validation for a Provider Template naming an unknown adapter is deleted, along with the errors it raised.
- [ ] The Adapter Registry still rejects duplicate Pack ids at construction.
- [ ] The suites that enumerate Providers by hand iterate the Pack list rather than branching per brand.
- [ ] No suite outside those three is edited. An edit elsewhere means behaviour changed and is a defect in this ticket.
- [ ] Adding a Provider Pack requires no edit to any barrel, registry or harness.
- [ ] No database migration is introduced.
