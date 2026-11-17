# An Owner addition joins every curated Upstream Key's allow-list

A model the Owner adds to a Provider's Model Catalog by hand is the Owner's
word that the Provider serves it (ADR-0030). An explicit per-Key allow-list is
the Owner's word about what one Key serves, and it outranks everything else
(ADR-0029). When every Key of a Provider carries an allow-list, the two words
contradicted each other: the Models card listed the addition, and every Request
for it was refused as `model_unroutable`, because no Key's list named it.

## The case

Provider `gpt` (a generic OpenAI-compatible upstream) has 28 Keys, each with an
allow-list of 1 to 9 models. The Owner added `gpt-6.2-sol`; the Test request
returned 404 `model_unroutable`. Sent directly with one of those Keys, the
upstream served the model. Its `GET /models` answers 401, so discovery cannot
say which Keys serve what. The only way to route the model was to edit 28
allow-lists by hand.

## The rule

- Adding a model by hand also appends it to the allow-list of every Key on that
  Provider that carries one, in the same transaction as the catalog row, so an
  added model is never left unroutable.
- A Key with no allow-list (null) is left alone: it already admits the model.
- A Key whose deny-list names the model is left alone: the deny-list is the
  Owner's narrower word about that Key.
- One audit entry records the addition (`model_catalog.owner_added`), naming
  the model and how many allow-lists it joined (`allowListsJoined`).
- Removing the Owner addition takes the model off **every** allow-list on the
  Provider (`allowListsLeft` in the audit entry), not only the ones the
  addition joined. Which lists an addition joined is not tracked; tracking it
  would need a new per-Key provenance column, and with the catalog row gone no
  Key should keep naming the model anyway. An allow-list that held only that
  model becomes empty, never null: an empty list still admits nothing.
- Excluding a model does not touch allow-lists; the exclusion already refuses it.
- Models already in the catalog before this rule are not backfilled.

A Key that cannot really serve the model fails over to the next Key through the
existing retry path, the same cost ADR-0023 accepts for under-reported models.

## Alternatives rejected

- **Probe each Key with a minimal request before adding the model to its list.**
  Accurate per Key, but it spends a real inference per Key per model, needs a
  failure classifier for "model not found" versus "not entitled" versus
  "unknown", background retries for the unknowns, and a recheck action. The
  failover path already absorbs a wrong guess at the cost of one Attempt.
- **Let an Owner addition bypass allow-lists at routing time.** It would make an
  allow-list mean "these models, plus anything the Owner adds to the Provider",
  so the Owner could no longer read a Key's list as what that Key serves, and
  ADR-0029's rule that an explicit list is decisive would have an exception
  hidden in the router. Writing the model onto the lists keeps the list the
  single, visible, editable source of truth.
- **Use discovery.** `GET /models` is unavailable on the measured upstream
  (401), and where it works it under-reports (ADR-0023); ADR-0029 already stops
  discovery for curated Keys.
