# Iroha v2 — references for the two directions

All images are real shipped screens pulled from Mobbin with poppin (clean copies, no watermark). They are in `references/`, numbered as below.
"Dir" says which direction borrows it: **A** = Workbench (light, calm), **B** = Console (dark, dense), **A+B** = both.

## Tables with bulk selection

| # | App | What it does well | What to borrow | Dir |
|---|---|---|---|---|
| 11 | incident.io | Selection shows as a small floating bar at the bottom ("2/3 selected · Bulk action · Deselect all"), so the table does not move | Floating bulk pill for the Upstream Keys table | A |
| 12 | Customer.io | Clear "40 out of 41 selected" count. Destructive bulk actions ask you to type the count to confirm | Selected count wording; typed confirm for bulk Delete | A+B |
| 20 | Apollo | When rows are selected, the bulk toolbar takes the place of the tab/filter row: Clear 1 selected, Mark complete, Set due date, Export, Archive | Inline bulk toolbar in place of the filter row | B |
| 19 | Twenty | Selected rows plus "3 selected" in the breadcrumb, and a right panel "Update records · 3 selected" with Apply ⌘↵ | "Edit 3 keys" side panel (Key State, Endpoints, Model Gaps) | B |
| 21 | Supabase Table Editor | Spreadsheet grid with cell borders, column type hints, "Sorted by 1 rule", pagination footer | Grid look of the Upstream Keys table | B |
| 23 | PlanetScale Insights | Dense numeric table with sparklines; a "View options" checklist for columns | Right-aligned mono numbers; column picker | B |
| 24 | Braintrust | Compact toolbar: All rows / Filter / Columns / Group / Row | Toolbar order and size | B |

## API keys and the create-key dialog

| # | App | What it does well | What to borrow | Dir |
|---|---|---|---|---|
| 03 | Vercel AI Gateway — API Keys | Very quiet list; masked key suffix in a small chip; "Used 1 minute ago" | Gateway Keys list, secret suffix chip | A |
| 04 | Vercel — New AI Gateway API Key | Small, centred dialog with one field and a black primary button | Dialog proportions and button weight | A |
| 06 | Linear — create API key | Radio "Full access / Only select permissions", then a checklist with a description on each option | Full access vs. Only selected Providers and Pools | A |
| 07 | OpenAI Platform — create secret key | Segmented All / Restricted / Read only, then one row per resource with a None/Read select on the right | One row per Provider or Pool with a model select on the right | A |
| 09 | Resend — Add API Key | Tiny dialog; keyboard hints on the buttons (Add ⌘↵, Cancel Esc) | Shortcut hints on Create key / Cancel | A+B |
| 13 | Supabase — API keys | Key shown in a mono pill with reveal and copy | Show-once secret field after creation | A+B |
| 22 | Cloudflare — create token | A side sheet, not a modal. Permission rows are `Resource › Scope › Level` with × and "Add +". Shows the same call as code | Grant rows of [Provider/Pool] [models] [×], "+ add grant", the admin API curl | B |

## Model pickers over thousands of items

| # | App | What it does well | What to borrow | Dir |
|---|---|---|---|---|
| 05 | Vercel — Model List | Dense model table (context, max output, latency, price); "All Providers" checklist popover; "Columns (13)" | Model checklist inside a grant; Models tab density | A+B |
| 14 | Cursor — model picker | Plain multi-select checklist with search | Model multi-select in the Gateway Key dialog | A+B |
| 25 | Google AI Studio — model selection | Model picker as a right-hand sheet, with search and category chips | Model picker that opens inside the side sheet | B |

## Request logs, live feeds and detail panels

| # | App | What it does well | What to borrow | Dir |
|---|---|---|---|---|
| 01 | Stripe Workbench — request logs | List grouped by day on the left, properties and JSON body on the right. Filter pills "⊕ Date / Status / … Clear filters" | Split list + detail, and the filter pills | A |
| 02 | Stripe Workbench — events (dark) | Event list with a JSON drawer | Showing upstream error bodies as code | A+B |
| 08 | OpenAI Platform — log detail | Right "Properties" column of key/value pairs | Request properties block | A |
| 10 | Resend — log detail | "POST /emails" title, small key/value grid, status badge, dark code blocks for bodies | Detail header and the body blocks | A |
| 15 | Vercel — Logs | Left facet panel (collapsible groups with counts, Reset), mono timestamps, query bar, Live button, histogram | Facets for status / attempts / Caller, the query bar, Live | B |
| 16 | Railway — logs (dark) | Very dense mono rows; error rows tinted red; view options to toggle columns | Row density and red-tinted failed Requests | B |
| 17 | Railway — log detail | Drawer over the list with ↑/↓ to step through rows, tabs, Raw Data JSON, "View in Context" | Request drawer with ↑/↓, tabs Attempts / Captured / Logs / Raw | B |
| 18 | Cloudflare Workers — observability | Histogram, time range 15m/1h/24h/3d/7d, Live, rows with a coloured left bar | Histogram strip and the time-range segment | B |

## Also looked at, not used for these 3 screens

Grok Chat API playground and LangChain playground (for the Provider Test panel later), Modal logs, Sentry request log, Browserbase filter chips, Dub events table, Clerk API keys, Neon table, Laravel Cloud and Sentry webhook deliveries, fal / Langdock / Cloudflare model selectors, Mistral and Cloudflare playgrounds. The full set of 50 is in `iroha-refs` on the laptop.
