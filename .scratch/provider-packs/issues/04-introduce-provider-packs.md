# 04 — Introduce Provider Packs beside the existing declarations

**What to build:** Declare each upstream brand Iroha knows as a Provider Pack — one module holding one Provider Template, one Inference Adapter and one Usage Adapter — and build the Adapter Registry from the list of Packs. See ADR-0019.

A Pack is a declaration only. It holds its Provider Template as data and references its adapter factories; adapter behaviour always lives in its own module beside the Pack, never inside it, whatever its size. That rule has no exception, so the location of a Provider's behaviour is always predictable.

A Pack's id is the Provider Template id it carries, so nothing persisted changes and no migration is required.

This is the expand step. The existing adapter-id constants and their exports stay in place and keep working; ticket 06 removes them once nothing depends on them.

**Blocked by:** 03.

**Status:** ready-for-agent

- [ ] A Provider Pack type exists, holding one Provider Template, one Inference Adapter factory and one Usage Adapter factory.
- [ ] Every built-in brand is declared as a Pack, including the Generic OpenAI-compatible and Generic Anthropic-compatible defaults.
- [ ] The built-in Packs are a single ordered list, and that list is the only source of the Provider Templates the Adapter Registry offers.
- [ ] A Pack's id is the Provider Template id it carries. No Provider Template declares an id of its own.
- [ ] The Provider Template picker shows the same Provider Templates in the same order as before.
- [ ] Existing adapter-id constants and exports still resolve and still work. Nothing outside the registry is edited.
- [ ] Every existing test passes unedited.
- [ ] No database migration is introduced.
