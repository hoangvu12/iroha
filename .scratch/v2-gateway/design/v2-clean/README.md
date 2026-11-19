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
- The mockups use LobeHub's icon set (`@lobehub/icons-static-png`) as stand-ins.

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
| `C17-chat-as-gateway-key.png` | Chat opened from a Gateway Key: "Sending as zeron-fleet", only that key's models can be picked, message prefilled |
| `C18-request-route.png` | A Request's Route view: the path it took as a chain of cards on a canvas, with the selected Attempt's details on the right |
| `C19-model-pool-route.png` | Model Pool glm-4.6, Route tab: where a Request would go right now, with the selected member's keys on the right |

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

## Still to do

- Dark mode.
- Phone layouts.
- The states board: loading, empty, error, confirm and toasts.
- The Captured view for a Request.
- The model list that opens from the top row of the composer's picker.
- Settings: Admin Tokens and Audit Entries.

The design tool stopped loading images partway through, so in C04, C18 and C19 the banner and logos were pasted onto the exports afterwards, in the same places and sizes.

The Login art is the 728×546 banner scaled up, so it looks soft at full size. A larger copy of the art would fix that.
