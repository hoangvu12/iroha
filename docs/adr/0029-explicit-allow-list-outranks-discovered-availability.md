# An explicit per-Key model allow-list outranks a discovered Key Model Availability

A Provider's Upstream Key may carry an explicit `allowedModels` list: the
Owner's own statement of which models that Key serves. Key Model Availability
is what the Provider said the Key can call, discovered from `GET /models`. The
two now answer different questions, and where they disagree the Owner's answer
wins.

The rule: when a Key carries an explicit allow-list, that list decides
eligibility on its own. The discovered list no longer removes such a Key from a
Request, and the Model Catalog no longer takes its ids from discovery. A Key
without an explicit list is unaffected — Key Model Availability still orders
the eligible Keys and still refuses a model that no known list carries
(ADR-0023).

## Why the two were allowed to disagree

ADR-0023 measured why a discovered list is weak evidence: `GET /models` is
reliable when it says yes and unreliable when it says no, and the lists of one
Provider's Keys are not nested. It made availability *positive evidence* —
"a listed model is reliable, an unlisted one is unproven" — and said it should
order the eligible Keys rather than remove one.

ADR-0028 then made the gateway's model ID a per-endpoint alias: one gateway ID
can reach several endpoints that each call it something different. It kept the
two concerns apart — "the allow-list decides eligibility, the rewrite decides
the wire name" — but eligibility was still decided twice. The code filtered a
Key by its allow-list and then filtered it again by the discovered list, and
compared the gateway's ID against a list written in the upstream's ID space, so
a Key the Owner said could serve a model was removed for not naming that model
in the upstream's spelling.

The measured case: a Provider whose models are curated by hand, one shared ID
per model, each Key naming the upstream's own spelling (ADR-0028's rewrite).
The upstream advertised its catalogue in its own ID space, so no discovered list
ever named the gateway's ID, and the Provider could not route a single model it
could serve — it refused every one as `model_unroutable`. It also listed the
upstream's whole advertisement in the Model Catalog: hundreds of models it
does not serve.

## What changed

- `resolveInference` treats an explicit allow-list as decisive for that Key.
  A Key with a list that omits the model is still ineligible
  (`keyServesModel`, unchanged); a Key with a list that names it is no longer
  removed because a discovered list does not.
- A Key with no explicit list is compared against the discovered list in the ID
  the Request will actually carry — its rewrite when it has one, and its
  canonical ID as well. The comparison was against the canonical ID alone, so a
  rewritten model could never match a list written upstream.
- `discoverMissingKeys` does not write Key Model Availability for a Key that
  already carries an explicit allow-list, so adding a Key to a curated Provider
  neither re-discovers it nor repopulates the Model Catalog with the upstream's
  advertisement.
- A Provider whose every Key carries an explicit allow-list is fully described:
  a model no Key's list names is refused as `model_unroutable` (404, permanent)
  rather than reported as temporarily unavailable (503). The two codes are
  deliberately distinct (ADR-0023): a model no Key can serve will not answer on
  a retry, and saying "try again later" sends a caller after a model this
  Provider will never serve.

## What did not change

A Key without an explicit allow-list keeps exactly the ADR-0023 behaviour: a
model absent from every known list is refused before any Attempt, and a Key
that carries no model is not tried. The stock Providers — DashScope, Z.AI,
MiniMax and the rest — leave their Keys' lists empty, so nothing about their
entitlement, ordering, or refusals moves.

## Alternatives rejected

- **Reading availability as ordering only, everywhere.** This is what CONTEXT.md
  says ("never removes one") and it is the honest description of ADR-0023's
  measurement, but it would change the refusal behaviour of every stock
  Provider that relies on per-key entitlement, and it would let a request for a
  model no Key can serve reach the upstream.
- **Making the allow-list and the discovered list agree by storing upstream
  IDs.** That would mean discovering a second list in a second ID space for
  every curated Key and reconciling them — the bookkeeping this rule removes.
- **Fixing only the ID-space mismatch.** That fixes a rewritten model matching a
  discovered list, but a Provider that lists a model the upstream never
  advertises still loses the Key, and the Model Catalog still takes the
  upstream's advertisement. It treats the symptom.
