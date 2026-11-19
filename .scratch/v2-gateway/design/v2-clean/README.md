# Iroha v2 — clean direction

This direction follows the Owner's feedback that A and B were too busy. It stays close to the calmest references: Vercel API keys, Resend, Stripe request logs and Linear (see `reference-sheets/`).

Rules it follows:

- One fact per cell. No `a · b · c` lines that string facts together.
- Each page has one primary button. Filters sit behind a single control.
- Light theme, Inter, near-black buttons. Colour comes only from status dots, logos and the Iroha art.
- Requests is the exception to "keep it short": it shows as much as fits, still one fact per column.

## Shell

The sidebar copies v1:

- The Iroha banner at the top (`/brand/iroha-sidebar-banner.jpg`), 84px tall and cropped to fill.
- Nav items with single-key shortcuts (P, G, R).
- Settings, then the Owner row with sign out.

There is no brand or status row; the Owner asked to remove it.

## Logos

- **Providers** show their brand logo in a round tile, as in v1's `ProviderIcon`, resolved through the backend from the Logo Domain.
- **Model Pools** show the model family's logo in a rounded-square tile, so a Pool never looks like a Provider. For example glm-4.6 uses Zhipu and kimi-k2 uses Kimi.
- Where the logo comes from (approved by the Owner):
  - A Provider's logo comes from its Logo domain, which you can edit in Provider Settings.
  - A Pool's maker is guessed from the model name, and you can edit it on the Pool.
- If no logo is found, the tile shows the first letter of the name, still round for Providers and a rounded square for Pools. C25 and C30 show it with my-vllm and house-mix.
- The mockups use LobeHub's icon set (`@lobehub/icons-static-png`) as stand-ins.

## Test traffic

A chat sent "as" a Gateway Key uses that key's access but is recorded with the Caller `Test (as <name>)`. It never counts as that key's traffic. The label shows up in three places:

- The Caller column in Requests (C03, C04, C21, C32).
- The Caller filter (C25, under "No results").
- The chat's "Sending as" bar, with "Shows in Requests as Test (as zeron-fleet)" under it (C17, C33).

## Screens

| File | Screen |
|---|---|
| `C01-provider-keys-selected.png` | Provider → Keys, 3 selected. The selection bar replaces the toolbar: Test, Disable, ⋯ |
| `C02-new-gateway-key.png` | New Gateway Key: Name, then Access (Everything / Only some), with a checklist of Providers and Pools |
| `C03-requests-feed.png` | Requests: stats row and a 12-column table |
| `C04-requests-detail.png` | Requests with one open, Details tab: Route, Timing, Tokens. Attempts and Captured are tabs |
| `C05-providers.png` | Providers list and Model Pools list (Pools show the Providers serving them as a logo stack) |
| `C06-model-pool.png` | Model Pool glm-4.6: stats and ordered members (drag to reorder, switch each member on or off), plus the Gateway Keys that can use it |
| `C07-provider-endpoints.png` | Provider → Endpoints: name, URL, Shape, which keys work on it; Provider settings (name, Logo domain, enabled) |
| `C08-provider-models.png` | Provider → Models: search over 1,284, an "All / With Model Gaps" filter, keys with access, Model Gaps with Clear, paging |
| `C09-provider-rules.png` | Provider → Rules: Failure Rules with Status, Body contains, what happens to the Upstream Key and to the Request, hits, source, on/off |
| `C11-add-upstream-keys.png` | Add Upstream Keys: paste, a preview naming each key and flagging ones already added, an option to test after adding |
| `C12-gateway-key-created.png` | Key created: the full key shown once, the Base URL, and both with Copy |
| `C13-login.png` | Login: Iroha art on the left; avatar, password and Sign in on the right |
| `C14-provider-settings.png` | Provider → Settings: rows in cards (General: Name, Logo, Enabled; Provider route; Danger zone) |
| `C15-chat-from-provider-test.png` | The shared chat sheet, opened by Test on dashscope: tool call, collapsible Details per reply, streaming |
| `C16-chat-model-picker.png` | The composer's model picker: model, then Provider, Upstream Key, Endpoint, Shape, Send as, Reasoning, tool-call check |
| `C17-chat-as-gateway-key.png` | Chat opened from a Gateway Key: "Sending as zeron-fleet", shown in Requests as Test (as zeron-fleet), only that key's models can be picked |
| `C18-request-route.png` | A Request's Route view: the path it took as a chain of cards on a canvas, with the selected Attempt's details on the right |
| `C19-model-pool-route.png` | Model Pool glm-4.6, Route tab: where a Request would go right now, with the selected member's keys on the right. Backed by a real API |
| `C20-dark-provider-keys.png` | Dark: Provider → Keys, 3 selected |
| `C21-dark-requests-detail.png` | Dark: Requests with the drawer open |
| `C22-dark-request-route.png` | Dark: a Request's Route view |
| `C23-dark-chat-panel.png` | Dark: the chat sheet over Provider → Keys |
| `C24-dark-new-gateway-key.png` | Dark: New Gateway Key |
| `C25-states.png` | States board: loading, empty, no results, error, confirm delete, confirm revoke, toasts with Undo, logo fallback |
| `C26-request-captured.png` | Request drawer, Captured tab: Caller sent / Sent upstream / Response, each message in order, Copy as cURL, Replay in Chat |
| `C27-chat-model-list.png` | The composer's full model list (from the picker's top row): search, All / Model Pools / Used recently, grouped by Pool and Provider, keyboard hints |
| `C28-settings-admin-tokens.png` | Settings → Admin Tokens: name, token, created, last used, expires. Revoke from the ⋯ menu |
| `C29-settings-audit-entries.png` | Settings → Audit Entries: grouped by day, who, what, target, Revert. One open to show before and after |
| `C30-phone-providers.png` | Phone: Providers and Model Pools. The Iroha avatar top right opens Settings |
| `C31-phone-provider-keys.png` | Phone: Provider → Keys, two lines per key |
| `C32-phone-requests.png` | Phone: Requests, two lines per Request, failed rows tinted |
| `C33-phone-chat.png` | Phone: chat sent as a Gateway Key |

## Dark mode

- The same screens and the same colour tokens, with a dark value for each, so nothing is drawn twice.
- The page is near-black (#0E0E10), with the sidebar and canvas one step lighter.
- Status colours are lighter versions of the light ones, and their tinted backgrounds are darker.
- The primary button turns light, so it still stands out.
- Logos use LobeHub's dark set, so black marks like z-ai and openrouter turn white.

## States (C25)

- **Loading:** grey bars in the shape of the rows, with no spinner.
- **Empty:** one sentence and the one action that fills the page.
- **No results:** the filters stay on screen as chips, with Clear filters underneath.
- **Error:** says what failed, keeps the page around it, and offers Try again. The failed call is shown in small mono text.
- **Confirm:** only for actions that can't be undone, or that remove something.
  - Delete names exactly what will go.
  - Revoke asks you to type the key's name.
  - Red appears only on the button that does it.
- **Toasts:** bottom right, for 6 s. Every change that can be put back gets Undo, including a Revert from Audit Entries. Disable, enable and clearing Model Gaps don't ask first; they rely on Undo.

## Settings (C28, C29)

These are kept as plain as the other pages: a title, two underline tabs and a table. There are no cards and no extra sections.

- **Admin Tokens:**
  - One line explains what a token can do, next to the New Admin Token button.
  - A token not used for a month shows its Last used in amber.
- **Audit Entries:**
  - Each row has one fact per column: time, who (the Owner or an Admin Token), what changed, and on what.
  - Opening a row shows before and after.
  - Revert sits on the row. Changes that can't be undone, like a revoke, say "Can't be reverted" instead.

## Phone (C30–C33)

- The sidebar becomes a bottom tab bar: Providers, Gateway Keys, Requests and Chat. Settings sits behind the Iroha avatar at the top of Providers.
- Tables become two-line rows: the main facts on the first line, the secondary ones under them. There are still no dot-chained facts.
- On a phone, Chat is a full page and not a sheet. It has the same history button, model chip and "Sending as" bar.

## Route views

Both follow AirOps' workflow canvas: a dotted canvas, one vertical chain of cards joined by lines, and a panel on the right for the selected card. The chain is read-only in Iroha. You reorder members on the Members tab, not by dragging cards.

Every card is built the same way, so the eye knows where to look:

- a logo tile on the left;
- a small grey label on top ("Attempt 1", "Member 2") and the name below it in bold;
- one badge on the right: the status code, or how many keys are ready.

The selected card gets a blue ring. Each line between cards carries a pill only when it explains a jump ("Cooling, tried the next key", "If every key fails"). Chains start with a Start card and end with an End card.

C18, a Request's Route:

- It opens full page from the Request drawer. The tabs are Route, Details and Captured.
- The chain is Start (the Caller and the model asked for), each Attempt, then End (the response and total time).
- The right panel shows the selected Attempt in this order: the result, What Iroha did (Failure Rule, Key State, Then), Sent to, then the raw upstream error.

C19, a Model Pool's Route:

- It's live, built from the current Key States and Model Gaps. Nothing is sent.
- The chain is Start, the members in order, then End ("503, no key could serve"). A switched-off member sits faded under the chain.
- The right panel shows the selected member: what it sends, the keys skipped right now with the reason, and the ready keys in the order they're tried.

Research notes: only Cloudflare AI Gateway draws a real node graph (its routes are built by hand). Vercel AI Gateway, OpenRouter and Portkey list attempts per Request. None shows a route before it happens.

## Chat (replaces the old Test tab)

- One shared right sheet, 460 wide. It doesn't block the page and stays open while you move between pages.
- It opens from the sidebar's Chat item (shortcut C) or from any Test button.
- It holds chats only. All the setup lives in the composer's model chip.
- Test buttons open it already set up:

  | Opened from | What gets filled in |
  |---|---|
  | Provider | That Provider |
  | Model Pool | That Pool |
  | Key row's ⋯ menu | That Upstream Key |
  | Gateway Key | Sends as that Caller |
  | A Request | Its prompt, for a replay |

- One chat at a time, with no tabs. Each Test starts a new chat; earlier chats are in the history dropdown in the sheet header. The expand button turns the sheet into a full page.
- Bulk Test on selected keys is a different thing: a quick check whose result shows on the rows, not a chat.

## How the images were made

The design tool stopped drawing images partway through this work. It draws nothing at all for an image, not even its grey placeholder, and restarting Zeron isn't possible from the design side. So in C03, C04, C17 and C18–C33, the banner, logos and avatar were pasted onto the exports afterwards, at the same places and sizes. The layout is unaffected, since only the pictures inside the tiles were added.

The States board (C25) is exported at 1.5× instead of 2×, because at 2× it's too large for the exporter.

The Login art is the 728×546 banner scaled up, so it looks soft at full size. A larger copy of the art would fix that.
