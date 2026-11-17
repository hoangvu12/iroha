# An Owner addition is vouched for against discovered Key Model Availability

A model the Owner adds to a Provider's Model Catalog by hand is the Owner's
statement that the Provider serves it. Discovered Key Model Availability is
what `GET /models` said each Upstream Key can call. Where the two disagree,
the Owner's statement wins: discovered lists still order the Keys for an
Owner addition, but they never refuse it and never remove a Key from it.

## The case

Every Provider Template that does not declare `modelAvailability: 'provider'`
is key-scoped, so each Key's `GET /models` answer becomes its Key Model
Availability. A model absent from every known list is refused as
`model_unroutable`, and a Key whose known list omits the model is not tried
(the tightening ADR-0029 kept for Keys without an allow-list).

An Owner addition is usually there *because* discovery does not report it: the
upstream under-reports, or advertises a different spelling. So the Models card
listed the model, the Code Snippet offered it, and every Request for it was
refused with a 404 before any Attempt — the exact under-reporting ADR-0023
measured (`GET /models` is reliable when it says yes and unreliable when it
says no), now overriding the Owner's own word.

## The rule

- For a model whose catalog row is an Owner addition, `resolveInference` skips
  the "absent from every known availability" refusal and does not drop Keys
  whose discovered list omits it. It falls back to ADR-0023's ordering: Keys
  known to carry it rotate first, the rest stay reachable behind them.
- Allow- and deny-lists still filter (`keyServesModel`). They are the Owner's
  word about one Key, and they outrank an Owner addition about the Provider,
  just as ADR-0029 has them outrank discovery. A Provider whose every Key
  carries an allow-list that omits the model still refuses it as
  `model_unroutable`.
- An Owner exclusion still refuses the model before routing.
- A model the Owner did not add keeps ADR-0023/0029 behaviour unchanged: absent
  from every known list, it is refused.

Once discovery reports an Owner addition on some Key, the row becomes
`discovered` and the ordinary rule already routes it.

## Alternatives rejected

- **Ordering only, for every model.** Would let a mistyped or unserved model
  burn one Attempt per Key on every key-scoped Provider. ADR-0029 rejected it
  for the same reason.
- **Hiding unroutable Owner additions in the UI.** The Models card and the Code
  Snippet would disagree again, and the Owner would have no way to route a
  model the upstream under-reports short of an allow-list on every Key.
- **Requiring an allow-list instead.** Works, but turns "add this model" into
  "curate every Key", and an allow-list also removes every other model from
  that Key.
