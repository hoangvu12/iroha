# A Provider Pack pairs one Provider Template with its adapters

Iroha's built-in knowledge of one upstream brand — its Provider Template, its Inference Adapter, and its Usage Adapter — lives in one module per brand under `src/providers/packs/`, and the built-in Packs are registered as a list. Before this, those three parts sat in six files joined only by adapter-id strings, so adding a typed Provider meant five source edits plus two barrel exports, and nothing structurally prevented one from being missed — `test/support/app.ts` never injected the mock upstream transport into the Z.ai Inference Adapter, so assembled tests for a Z.ai Provider reached the real network.

We rejected merging the adapters into the Provider Template itself. A Provider Template is a creation-time setup aid; the adapters are runtime behaviour. Collapsing those two lifetimes into one type is precisely what led every caller to re-derive an adapter from `templateId` independently, each with its own fallback. Keeping them as separate values inside one Pack also preserves data-only Provider Templates (ADR-0004): a Pack holds the Template as data and references adapter factories beside it, rather than turning the Template into code.

A Pack's ID is the Provider Template ID it carries, so the persisted `providers.template_id` column keeps working unchanged and no migration is required. A Provider whose `template_id` is null resolves to the Generic OpenAI-compatible Pack, so no caller needs a fallback branch.

## Consequences

The Adapter Registry currently rejects, at construction, a Provider Template that names an unregistered adapter. A Pack holds its adapter factories directly, so that class of error becomes unrepresentable and the check is removed along with the adapter-id constants.
