import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgent } from "@ui-sdk/react/agent";
import { afterEach, expect, test, vi } from "vitest";
import { RequestsFeed } from "@/pages/requests/Feed";
import { renderWithSheets, routes } from "./test-iroha";

const agent = createAgent();

afterEach(() => vi.unstubAllGlobals());

const where = () => screen.getByRole("status", { name: "Location" }).textContent;
const sheets = () => screen.queryAllByRole("dialog");
const hrefOf = (el: HTMLElement) => decodeURIComponent(el.getAttribute("href") ?? "");

const req1 = routes["GET /api/requests/req_1"] as Record<string, unknown>;
const req2 = { ...req1, id: "req_2", model: "slow", started_at: "2026-11-19T09:59:00Z", pool: undefined };
routes["GET /api/requests/req_2"] = req2;
routes["GET /api/requests"] = { requests: [req1, req2], cursor: 1 };
routes["GET /api/requests/stats"] = { requests: 2, in_progress: 0, succeeded: 2, failed: 0, retried: 0, tokens: { input: 0, output: 0, cache_read: 0, reasoning: 0, total: 0 } };
routes["GET /api/requests/filters"] = { callers: [], providers: [], pools: [], models: [] };

/** A feed row (DataTable): the row holding the "Open Request <id>" button. */
const feedRow = async (id: string) => (await screen.findByRole("button", { name: `Open Request ${id}` })).closest("tr")!;

test("a feed row opens the Request sheet first; ↓ steps to the next row in place; a row click replaces the stack", async () => {
  const user = userEvent.setup();
  renderWithSheets(<RequestsFeed />, "/requests");
  await user.click(await feedRow("req_1"));
  const sheet = await screen.findByRole("dialog", { name: "Request fast" });
  await waitFor(() => expect(where()).toBe("/requests?sheet=request:req_1"));
  expect((await feedRow("req_1")).getAttribute("aria-current")).toBe("true");

  await user.keyboard("{ArrowDown}");
  await waitFor(() => expect(where()).toBe("/requests?sheet=request:req_2"));
  // ↑/↓ swaps the content in the same sheet: nothing slides (a key, many a day).
  expect(await screen.findByRole("dialog", { name: "Request slow" })).toBe(sheet);
  expect((await feedRow("req_2")).getAttribute("aria-current")).toBe("true");

  await user.click(await within(screen.getByRole("dialog", { name: "Request slow" })).findByRole("link", { name: "acme" }));
  await screen.findByRole("dialog", { name: "Provider acme" });
  await user.click(await feedRow("req_1"));
  await waitFor(() => expect(where()).toBe("/requests?sheet=request:req_1"));
  await waitFor(() => expect(sheets()).toHaveLength(1));
  // A row clicked while a Request is open shows it in that sheet: no slide out and in again.
  expect(screen.getByRole("dialog", { name: "Request fast" })).toBe(sheet);
});

test("the open Request's neighbours in the feed are fetched ahead, so ↓ shows the next one whole, at once (UI ticket 18)", async () => {
  const user = userEvent.setup();
  const { fetch } = renderWithSheets(<RequestsFeed />, "/requests");
  await user.click(await feedRow("req_1"));
  await screen.findByRole("dialog", { name: "Request fast" });
  const asked = (path: string) => fetch.mock.calls.some(([url]) => String(url).split("?")[0] === path);
  await waitFor(() => expect(asked("/api/requests/req_2")).toBe(true));
});

test("a feed row's Caller, Pool, Provider and key are links to their sheets, not to the Request", async () => {
  const user = userEvent.setup();
  renderWithSheets(<RequestsFeed />, "/requests");
  const row = within(await feedRow("req_1"));
  expect(hrefOf(row.getByRole("link", { name: "zeron" }))).toBe("/requests?sheet=gateway-key:gk_1");
  // A Pool's name is the model the Caller asked for.
  expect(hrefOf(row.getByRole("link", { name: "fast" }))).toBe("/requests?sheet=pool:fast");
  expect(hrefOf(row.getByRole("link", { name: "acme" }))).toBe("/requests?sheet=provider:acme");
  expect(hrefOf(row.getByRole("link", { name: "team-5" }))).toBe("/requests?sheet=key:acme/team-5");
  // A model that names no Pool is no record: plain text.
  expect(within(await feedRow("req_2")).queryByRole("link", { name: "slow" })).toBeNull();

  await user.click(row.getByRole("link", { name: "team-5" }));
  await screen.findByRole("dialog", { name: "Upstream Key team-5" });
  await waitFor(() => expect(where()).toBe("/requests?sheet=key:acme/team-5"));
  expect(screen.queryByRole("dialog", { name: "Request fast" })).toBeNull();
});

test("a Request asked of a Provider straight links its model to the model's sheet (UI ticket 33)", async () => {
  const list = routes["GET /api/requests"];
  const req3 = { ...req1, id: "req_3", model: "acme/gpt-fast", wire_model: "gpt-fast", pool: undefined };
  routes["GET /api/requests"] = { requests: [req3], cursor: 1 };
  try {
    renderWithSheets(<RequestsFeed />, "/requests");
    const row = within(await feedRow("req_3"));
    expect(hrefOf(row.getByRole("link", { name: "acme/gpt-fast" }))).toBe("/requests?sheet=model:acme/gpt-fast");
  } finally {
    routes["GET /api/requests"] = list;
  }
});

test("an old ?request= link opens the Request sheet and becomes ?sheet=", async () => {
  renderWithSheets(<RequestsFeed />, "/requests?range=24h&request=req_1");
  await screen.findByRole("dialog", { name: "Request fast" });
  await waitFor(() => expect(where()).toBe("/requests?range=24h&sheet=request:req_1"));
});

test("phones show only the top sheet: the ones under it are out of reach", async () => {
  const real = window.matchMedia;
  window.matchMedia = ((q: string) => ({ ...real(q), matches: q === "(max-width: 767px)" })) as typeof window.matchMedia;
  try {
    renderWithSheets(null, "/x?sheet=provider:acme&sheet=key:acme/team-5");
    const top = await screen.findByRole("dialog", { name: "Upstream Key team-5" });
    const under = screen.getByRole("dialog", { name: "Provider acme", hidden: true });
    expect(under.hasAttribute("inert")).toBe(true);
    expect(top.hasAttribute("inert")).toBe(false);
    expect(await within(top).findByRole("button", { name: "Back" })).toBeTruthy();
  } finally {
    window.matchMedia = real;
  }
});

test("an agent finds every sheet control by name and follows a link to the next sheet", async () => {
  renderWithSheets(null, "/requests?sheet=request:req_1");
  const request = await screen.findByRole("dialog", { name: "Request fast" });
  await within(request).findByRole("link", { name: "acme" });
  const components = agent.snapshot().filter((e) => !e.offPage && e.component !== "more" && e.component !== "scroll-area");
  for (const entry of components) expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy();
  const labels = components.map((e) => e.label);
  for (const name of ["Request fast", "Open page", "Copy Request ID", "acme", "team-5", "main", "fast"]) expect(labels).toContain(name);

  const result = await agent.act({ steps: [{ ref: "team-5", action: "press" }] });
  expect(result.ok, result.error?.message).toBe(true);
  await screen.findByRole("dialog", { name: "Upstream Key team-5" });
  await waitFor(() => expect(where()).toBe("/requests?sheet=request:req_1&sheet=key:acme/team-5"));

  // Closing a sheet is the dialog's own action: the top one goes, back to the Request.
  const closed = await agent.act({ steps: [{ ref: "Upstream Key team-5", action: "close" }] });
  expect(closed.ok, closed.error?.message).toBe(true);
  await waitFor(() => expect(sheets()).toHaveLength(1));
  await waitFor(() => expect(where()).toBe("/requests?sheet=request:req_1"));
});
