# Iroha v2 — two directions to pick from

The first design set stays in `..\` and is unchanged. This folder holds two new directions built from real references (see `REFERENCES.md`). Each has only the three screens that matter most:

1. Provider detail (dashscope) with the Upstream Keys table, 3 keys selected
2. New Gateway Key
3. Requests feed with one Request open (the same request in both: zeron-fleet → dashscope/qwen3-coder-plus, served on attempt 3 after a 429 and a Model Gap)

Compare them side by side in `compare/`:

- `compare/1-provider-keys-bulk.png`
- `compare/2-new-gateway-key.png`
- `compare/3-requests-detail.png`

Full-size screens (2880×1800) are in `directions/`.

## A · Workbench

Light and calm, close to the Vercel, Stripe and Linear dashboards. Built for reading and deciding.

- **Layout.** A 240px light sidebar. Providers and Model Pools are listed inside the nav, each with its key count. Each page has a big title, a stat strip, then underline tabs.
- **Density.** 40px table rows, generous padding, one idea per column.
- **Type and colour.** Inter for UI text; JetBrains Mono only for IDs, models and numbers. White background, near-black primary buttons, and one blue accent for links and selection. Status is shown as a coloured dot plus a word.
- **Tables.** Borderless rows. Filters are dashed ⊕ pills in Stripe style. Selected rows get a soft blue fill.
- **Bulk selection.** A floating black pill at the bottom of the screen (incident.io style): "3 selected | Test · Enable · Disable · Endpoints · Clear Model Gaps · Copy | Delete | Esc". The table never moves.
- **New Gateway Key.** A centred 640px dialog. A Linear-style radio picks "Full access" or "Only selected Providers and Pools". Each Provider or Pool is a row with a select on the right (OpenAI style), and a row expands into a model checklist with search. Buttons show their shortcuts (Resend).
- **Requests.** A Stripe-style split. The left list is grouped by day, with two lines per Request. The right detail has a summary sentence, properties, an Attempts timeline and the upstream error body. Live and Pause sit in the top bar.

## B · Console

Dark and dense, close to Railway, Supabase, Vercel Logs and Cloudflare. Built for scanning many keys and requests at once.

- **Layout.** A 52px icon rail, plus a secondary panel that changes per page: the Provider list on Providers, filter facets on Requests. Detail always opens on the right, over the content, and never on a new page.
- **Density.** 30–32px rows, cell borders, mono everywhere, about twice as many rows on screen as A.
- **Type and colour.** Geist and Geist Mono on near-black. A violet accent marks selection and focus. Failed or invalid rows are tinted red, cooling rows amber, and Model Gaps pink.
- **Tables.** A spreadsheet grid (Supabase) with column type hints and right-aligned numbers.
- **Bulk selection.** Selecting rows swaps the filter row for an inline toolbar (Apollo). It also opens an "Edit 3 keys" side panel (Twenty) where you set Key State, Endpoints and Model Gaps together, then Apply ⌘↵.
- **New Gateway Key.** A right-hand side sheet, not a modal (Cloudflare). Name, then the choice All access / Scoped. Grants are rows of `[Provider or Pool] [models] [×]` with "+ add grant". A model picker opens inline with search over all 1,284 models. The sheet also shows the same call as an admin-API curl.
- **Requests.** A log explorer: facets with counts on the left (Vercel), a mono query bar, Live, a histogram of OK vs failed (Cloudflare), and a dense table. The Request opens in a drawer over the table (Railway). You step through Requests with ↑/↓, and the drawer has tabs Attempts / Captured / Logs / Raw.

## How they differ, in short

| | A · Workbench | B · Console |
|---|---|---|
| Feel | Calm admin dashboard | Ops tool / log viewer |
| Theme shown | Light (dark comes from tokens) | Dark (light comes from tokens) |
| Navigation | Wide sidebar with nested Providers | Icon rail and a context panel |
| Rows on a 900px screen | ~14 keys / ~12 requests | ~20 keys / ~20 requests |
| Bulk actions | Floating pill, actions run one at a time | Inline toolbar plus an edit panel for several changes at once |
| Create Gateway Key | Centred modal | Side sheet with grant rows and curl |
| Request detail | Fixed split, list stays fully visible | Overlay drawer, ↑/↓ through the feed, raw tabs |
| On a phone | Sidebar becomes a sheet; split becomes list → detail page | Rail becomes a bottom bar; facets and the drawer become full-screen sheets |
| Risk | Can feel sparse with 40+ keys per Provider | Can feel heavy for a one-person setup; needs care in light mode |

Both directions use the same domain and vocabulary as the spec and GLOSSARY: Provider, Endpoint, Shape, Upstream Key, Key State, Model Gap, Model Pool, Gateway Key, Request/Attempt, Failure Rule, Caller. Mixing is possible, for example B's Requests explorer inside A's shell.
