# 26: v1 conformance checklist

**What to build:** A checklist beside the spec that maps every essential behaviour and provider quirk in `docs/research/v1-case-catalog.md` to the v2 test that covers it, or marks it not applicable with a reason (for example cases that existed only because of v1's per-key allow-lists). Missing coverage is added as tests or filed as new tickets.

**Blocked by:** 07, 11, 14, 15, 16, 17, 18, 20

**Status:** ready-for-agent

- [ ] Every catalog case of kind essential or provider quirk has a test reference or a not-applicable reason
- [ ] Cases v1 got wrong are covered by tests that assert the correct behaviour
- [ ] Gaps found are filed as tickets in this folder
