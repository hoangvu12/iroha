import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { afterEach, expect, test, vi } from "vitest";
import { renderWithSheets, routes } from "@/sheets/test-iroha";
import { RouteViewPage } from "./RouteView";

// UI ticket 11: the Route view names records as links to their sheets.

afterEach(() => vi.unstubAllGlobals());

const hrefOf = (el: HTMLElement) => decodeURIComponent(el.getAttribute("href") ?? "");
const req1 = routes["GET /api/requests/req_1"] as Record<string, unknown>;
const attempt = (seq: number, key: string, status: number) => ({
  seq,
  started_at: "2026-11-19T10:00:00Z",
  provider_id: "p1",
  provider: "acme",
  endpoint_id: "e1",
  endpoint: "main",
  endpoint_url: "https://api.acme.test/v1",
  upstream_key_id: "k-" + key,
  upstream_key: key,
  wire_model: "gpt-fast",
  shape: "openai-chat",
  status,
  duration_ms: 400,
});
routes["GET /api/requests/req_rv"] = { ...req1, id: "req_rv", attempt_count: 2, attempts: [attempt(1, "team-5", 429), attempt(2, "team-6", 200)] };

const page = (
  <Routes>
    <Route path="/requests/:id/:tab?" element={<RouteViewPage />} />
  </Routes>
);

test("the route's cards and the selected step link the records they name; a card still selects", async () => {
  const user = userEvent.setup();
  renderWithSheets(page, "/requests/req_rv/route");
  const route = await screen.findByRole("group", { name: "Route of req_rv" });
  // Each Attempt card names its key as a link; the card itself is the button that selects it.
  expect(hrefOf(within(route).getByRole("link", { name: "team-6" }))).toBe("/requests/req_rv/route?sheet=key:acme/team-6");
  expect(hrefOf(within(route).getByRole("link", { name: "fast" }))).toBe("/requests/req_rv/route?sheet=pool:fast");

  // The first failed Attempt is selected: its panel links where it was sent.
  const panel = screen.getByRole("region", { name: "Selected step" });
  expect(hrefOf(within(panel).getByRole("link", { name: "acme" }))).toBe("/requests/req_rv/route?sheet=provider:acme");
  expect(hrefOf(within(panel).getByRole("link", { name: "main" }))).toBe("/requests/req_rv/route?sheet=endpoint:acme/main");
  expect(within(panel).getByRole("link", { name: "team-5" })).toBeTruthy();

  await user.click(within(route).getByRole("button", { name: "Start" }));
  expect(within(route).getByRole("button", { name: "Start" }).getAttribute("aria-pressed")).toBe("true");
  expect(hrefOf(within(panel).getByRole("link", { name: "zeron" }))).toBe("/requests/req_rv/route?sheet=gateway-key:gk_1");
  expect(within(panel).queryByText("gk_1")).toBeNull();
  expect(hrefOf(within(panel).getByRole("link", { name: "fast" }))).toBe("/requests/req_rv/route?sheet=pool:fast");

  await user.click(within(route).getByRole("link", { name: "team-6" }));
  await screen.findByRole("dialog", { name: "Upstream Key team-6" });
});

routes["GET /api/requests/req_rule"] = {
  ...req1,
  id: "req_rule",
  attempt_count: 2,
  attempts: [{ ...attempt(1, "team-5", 429), rule: "rate-limited", outcome: "cooling_key", reason: "429 slow down" }, attempt(2, "team-6", 200)],
};

test("the Attempt panel opens its key and its Failure Rule in place, as sheets over the Route view (review fixes 2)", async () => {
  const user = userEvent.setup();
  renderWithSheets(page, "/requests/req_rule/route");
  const panel = await screen.findByRole("region", { name: "Selected step" });
  expect(hrefOf(within(panel).getByRole("link", { name: "rate-limited" }))).toBe("/requests/req_rule/route?sheet=rule:acme/rate-limited");
  const open = within(panel).getByRole("link", { name: "Open team-5" });
  // Not the Keys page: the key's sheet over the Route view.
  expect(hrefOf(open)).toBe("/requests/req_rule/route?sheet=key:acme/team-5");
  await user.click(open);
  await screen.findByRole("dialog", { name: "Upstream Key team-5" });
});

// UI ticket 18: motion in the Route view. jsdom has no Tailwind, so this reads the classes on the real markup.
const classesOf = (el: Element) => el.getAttribute("class")!.split(/\s+/);

test("motion: a card's border and ring change together on the hover tokens; the panel comes in from its edge when it comes back, swaps at once, closes at once", async () => {
  const user = userEvent.setup();
  renderWithSheets(page, "/requests/req_rv/route");
  const route = await screen.findByRole("group", { name: "Route of req_rv" });
  const card = within(route).getByRole("button", { name: "Start" }).parentElement!;
  for (const k of ["transition-[border-color,box-shadow]", "duration-hover", "ease-[ease]"]) expect(classesOf(card)).toContain(k);
  expect(classesOf(card)).not.toContain("transition-shadow");

  const panel = screen.getByRole("region", { name: "Selected step" });
  const fade = ["starting:opacity-0", "starting:translate-x-(--motion-shift)", "transition-[opacity,translate]", "duration-list-in", "ease-out"];
  const root = panel.closest("[data-step-panel]")!;
  for (const k of fade) expect(classesOf(root)).toContain(k);
  // Another card: the same panel, its content swapped (no entrance again).
  await user.click(within(route).getByRole("button", { name: "End" }));
  expect(screen.getByRole("region", { name: "Selected step" }).closest("[data-step-panel]")).toBe(root);
  // Close: gone at once, nothing kept for an exit.
  await user.click(within(panel).getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("region", { name: "Selected step" })).toBeNull();
  expect(document.querySelector("[data-step-panel]")).toBeNull();

  // The view tabs' indicator slides on the indicator tokens, never on first placement.
  const indicator = screen.getByRole("tablist", { name: "Request views" }).querySelector("[data-slot=tabs-indicator]")!;
  for (const k of ["transition-[translate,width]", "duration-indicator", "ease-out", "data-[activation-direction=none]:transition-none"]) expect(classesOf(indicator)).toContain(k);
  expect(classesOf(indicator).filter((k) => /^duration-\d/.test(k) || k === "motion-reduce:transition-none")).toEqual([]);
});
