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

const req1 = routes["GET /api/requests/req_1"] as Record<string, unknown>;
const req2 = { ...req1, id: "req_2", model: "slow", started_at: "2026-11-19T09:59:00Z", pool: undefined };
routes["GET /api/requests/req_2"] = req2;
routes["GET /api/requests"] = { requests: [req1, req2], cursor: 1 };
routes["GET /api/requests/stats"] = { requests: 2, in_progress: 0, succeeded: 2, failed: 0, retried: 0, tokens: { input: 0, output: 0, cache_read: 0, reasoning: 0, total: 0 } };
routes["GET /api/requests/filters"] = { callers: [], providers: [], pools: [], models: [] };

test("a feed row opens the Request sheet first; ↓ steps to the next row in place; a row click replaces the stack", async () => {
  const user = userEvent.setup();
  renderWithSheets(<RequestsFeed />, "/requests");
  await user.click(await screen.findByRole("row", { name: "Request req_1" }));
  const sheet = await screen.findByRole("dialog", { name: "Request fast" });
  expect(where()).toBe("/requests?sheet=request:req_1");
  expect(screen.getByRole("row", { name: "Request req_1" }).getAttribute("aria-selected")).toBe("true");

  await user.keyboard("{ArrowDown}");
  await waitFor(() => expect(where()).toBe("/requests?sheet=request:req_2"));
  expect(await screen.findByRole("dialog", { name: "Request slow" })).toBeTruthy();

  await user.click(await within(screen.getByRole("dialog", { name: "Request slow" })).findByRole("link", { name: "acme" }));
  await screen.findByRole("dialog", { name: "Provider acme" });
  await user.click(screen.getByRole("row", { name: "Request req_1" }));
  await waitFor(() => expect(where()).toBe("/requests?sheet=request:req_1"));
  await waitFor(() => expect(sheets()).toHaveLength(1));
  expect(sheet).toBeTruthy();
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
  expect(where()).toBe("/requests?sheet=request:req_1&sheet=key:acme/team-5");

  // Closing a sheet is the dialog's own action: the top one goes, back to the Request.
  const closed = await agent.act({ steps: [{ ref: "Upstream Key team-5", action: "close" }] });
  expect(closed.ok, closed.error?.message).toBe(true);
  await waitFor(() => expect(sheets()).toHaveLength(1));
  expect(where()).toBe("/requests?sheet=request:req_1");
});
