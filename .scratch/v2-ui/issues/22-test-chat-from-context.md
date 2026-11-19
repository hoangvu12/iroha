# 22: Test chat starts from where you pressed Test

**What to build:** The Owner's feedback on the test chat (`web/src/pages/chat/`, `useChatPanel().open(target)`; API `GET /api/test/models` in `internal/testchat/routes.go`, architecture.md "Ticket 23: test chat"):

1. **Provider first in the model picker.** When the chat was opened from a Provider (its header or row Test), from one of its Upstream Keys, or a model of it is selected, the model picker lists that Provider's models first, under a heading with the Provider's name, then everything else as today (Pools, other Providers). Search filters both groups. The Owner can still pick any model. Same for a Pool opened from its page (that Pool first). If the server-side search can't order this, add a parameter to `GET /api/test/models` (e.g. `prefer=<provider>`), keep the served skill and OpenAPI in step, and test it in Go.
2. **No random default.** Opening from a Provider picks a predictable model, not a random one: the model it served most in recent Requests if any, else its first visible model in list order. Say in the header which Provider it came from, as today.
3. **Test a model.** Every model row on a Provider's Models tab (`pages/providers/Models.tsx`) has a Test action (row menu, and the row's hover actions if it has them) that opens the chat with that Provider and model selected (a new target, e.g. `{ kind: "model", provider, model }`). Same for a Pool member row (`PoolMembers.tsx`) for its Provider and model.

**Blocked by:** 03

**Status:** open

Owner request, 2026-11-19 (not in the original spec). Ticket 19 (chat panel motion) runs at the same time on the same folder: keep to picker contents, defaults and the new target, not motion; ticket 07 later moves the Models table onto DataTable and keeps the Test action.

- [ ] Opened from a Provider or its key, the picker shows that Provider's models first; any other model can still be picked
- [ ] Opening from a Provider selects a predictable model (most-served, else first), with tests
- [ ] Test on a model row (Models tab, Pool members) opens the chat with that model; agent test for the action
- [ ] Checked in headless Chrome, light, dark and phone width

## Comments
