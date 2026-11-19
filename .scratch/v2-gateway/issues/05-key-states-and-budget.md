# 05: Key States, generic Failure Rules and the Request budget

**What to build:** Failed Attempts are classified by a Failure Rule engine with the generic built-in rules (auth refusal → invalid; 429 → cooling key+model honouring `Retry-After`; 5xx and network → retry elsewhere; 400 → fail). Upstream Keys move between active, disabled, invalid and cooling (key or key+model, escalating to the key after 3 distinct models in 5 minutes), each with a recorded reason. Requests retry on other keys within the budget (3 Attempts, 61 s to first byte, per-Provider overrides, 96 s ceiling) and, when all fail, return an error listing each Attempt. Request detail shows each Attempt's matched rule and action plus a one-line summary.

**Blocked by:** 04

**Status:** ready-for-agent

- [ ] Every key always reports exactly one Key State and its reason via the API
- [ ] Invalid keys stay out until a test passes or the secret changes
- [ ] Cooling defaults to 60 s doubling to 1 h; reset times from responses are honoured
- [ ] An Attempt that used up its time is not replayed on the same key
- [ ] No candidate left → immediate error distinguishing "never servable" from "cooling until T"
- [ ] Failure bodies and headers stored on every failed Attempt
- [ ] Provider summary endpoint: state counts and cooling-until times
- [ ] Key test makes a tiny real chat call; enable/disable/test available singly and in bulk
- [ ] Key State changes are logged events
