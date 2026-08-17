# The upstream wire shape is Provider Template data, not Inference Adapter contract

`POST /providers/{provider}/v1/messages` must know whether the Provider's upstream speaks the Anthropic shape — in which case the caller's body passes through — or the OpenAI shape, in which case the body is translated and the answer translated back. It decided this by comparing the Provider Template ID against the literal `'anthropic'` (`src/http/inference.ts:1311`). That is wrong for the shipped `generic-anthropic-compatible` Template, whose whole purpose is an Anthropic-shaped upstream: its Providers had Anthropic-shape bodies translated *away* to OpenAI-shape and sent to an Anthropic endpoint. The Provider Template now carries a `wireFormat` field (`openai` or `anthropic`) and the route reads it.

We did not put the wire shape on the Inference Adapter contract. ADR-0010 rejected making every adapter declare which caller shapes it accepts, and that reasoning still holds: the wire shape describes the upstream a Provider points at, not a capability of the adapter translating for it. ADR-0010 is therefore untouched rather than superseded. We also rejected adding `'generic-anthropic-compatible'` to the string comparison, which repairs one Template and fails at the next one.

The field is read from the Provider Template at request time rather than stored per Provider, so there is no new column and no migration. Both proxy cases an Owner is likely to hit already select the correct Template — an Anthropic-shaped proxy from Generic Anthropic-compatible, an OpenAI-shaped one from Generic OpenAI-compatible — so no evidence yet justifies an Owner override.

## Consequences

One related defect is deliberately left open and tracked separately: on `/v1/messages` the route classifies upstream failures with the Anthropic Inference Adapter (`src/http/inference.ts:1264`), so a Z.ai or MiniMax Provider's typed Failure Classification does not run on that surface and its Key Health is not updated from that traffic. Fixing it requires the translating adapter to classify with the Provider's own error table before it translates the error envelope, which is a larger change than this one.
