import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { loadedSheet, renderWithSheets, routes } from "./test-iroha";

afterEach(() => vi.unstubAllGlobals());

const where = () => screen.getByRole("status", { name: "Location" }).textContent;
const sheets = () => screen.queryAllByRole("dialog");

test("Request → Provider → Upstream Key opens three sheets; closing returns one level at a time", async () => {
  const user = userEvent.setup();
  renderWithSheets(null, "/requests?sheet=request:req_1");
  const request = await screen.findByRole("dialog", { name: "Request fast" });
  const details = within(request);
  expect((await details.findByRole("link", { name: "acme" })).getAttribute("href")).toBe("/requests?sheet=request%3Areq_1&sheet=provider%3Aacme");
  expect(details.getByRole("link", { name: "team-5" })).toBeTruthy();
  expect(details.getByRole("link", { name: "main" })).toBeTruthy();
  expect(details.getByRole("link", { name: "zeron" })).toBeTruthy();
  expect(details.getByRole("link", { name: "fast" })).toBeTruthy();

  await user.click(details.getByRole("link", { name: "acme" }));
  const provider = await screen.findByRole("dialog", { name: "Provider acme" });
  await user.click(await within(provider).findByRole("link", { name: "team-5" }));
  const key = await loadedSheet("Upstream Key team-5");
  expect(sheets()).toHaveLength(3);
  await waitFor(() => expect(where()).toBe("/requests?sheet=request:req_1&sheet=provider:acme&sheet=key:acme/team-5"));
  expect(request.getAttribute("data-depth")).toBe("2");

  await user.click(within(key).getByRole("button", { name: "Close (Esc)" }));
  await waitFor(() => expect(sheets()).toHaveLength(2));
  expect(provider.hasAttribute("data-top")).toBe(true);
  await user.keyboard("{Escape}");
  await waitFor(() => expect(sheets()).toHaveLength(1));
  expect(request.hasAttribute("data-top")).toBe(true);
  await waitFor(() => expect(where()).toBe("/requests?sheet=request:req_1"));
});

test("the Request sheet's tab is in the URL", async () => {
  const user = userEvent.setup();
  renderWithSheets(null, "/requests?sheet=request:req_1/attempts");
  const request = await screen.findByRole("dialog", { name: "Request fast" });
  expect(within(request).getByRole("tab", { name: /Attempts/ }).getAttribute("aria-selected")).toBe("true");
  await user.click(within(request).getByRole("tab", { name: "Details" }));
  await waitFor(() => expect(where()).toBe("/requests?sheet=request:req_1"));
});

test("each record sheet shows its facts, links and Open page", async () => {
  renderWithSheets(null, "/x?sheet=gateway-key:gk_1");
  const gk = await screen.findByRole("dialog", { name: "Gateway Key zeron" });
  expect(await within(gk).findByRole("link", { name: "acme" })).toBeTruthy();
  expect(within(gk).getByRole("link", { name: "Open page" }).getAttribute("href")).toBe("/gateway-keys/gk_1");
  expect(within(gk).getByRole("link", { name: "fast" })).toBeTruthy();
  expect(within(gk).getByRole("button", { name: "Test as zeron" })).toBeTruthy();
  expect(gk.textContent).not.toContain("iroha_gk_secret1234");

  await userEvent.setup().click(within(gk).getByRole("link", { name: "fast" }));
  const pool = await screen.findByRole("dialog", { name: "Model Pool fast" });
  await within(pool).findByText("gpt-fast");
  expect(within(pool).getByRole("link", { name: "Open page" }).getAttribute("href")).toBe("/providers/pools/fast/route");
  expect(within(pool).getByRole("link", { name: "acme" })).toBeTruthy();
  expect(pool.textContent).toContain("gpt-fast");
});

test("the Gateway Key sheet's Requests count opens that key's Requests of the last 24 hours, by its ID", async () => {
  renderWithSheets(null, "/x?sheet=gateway-key:gk_1");
  const gk = await screen.findByRole("dialog", { name: "Gateway Key zeron" });
  const count = within(gk).getByRole("link", { name: "Requests of zeron, last 24 h" });
  expect(count.textContent).toBe("12");
  expect(count.getAttribute("href")).toBe("/requests?caller=gk_1&range=24h");
});

test("the Endpoint sheet lists the keys sent there; a missing record says so", async () => {
  renderWithSheets(null, "/x?sheet=endpoint:acme/main&sheet=key:acme/nope");
  await screen.findByRole("dialog", { name: "No Upstream Key nope" });
  const ep = screen.getByRole("dialog", { name: "Endpoint main" });
  expect(await within(ep).findByRole("link", { name: "team-6" })).toBeTruthy();
  expect(ep.textContent).toContain("https://api.acme.test/v1");
  expect(within(ep).getByRole("link", { name: "Open page" }).getAttribute("href")).toBe("/providers/acme/endpoints");
});

test("the Upstream Key sheet copies the key's name and its key, as the Keys tab does", async () => {
  const user = userEvent.setup();
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  renderWithSheets(null, "/x?sheet=key:acme/team-6");
  const key = await loadedSheet("Upstream Key team-6");
  await user.click(within(key).getByRole("button", { name: "Copy key name" }));
  await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("team-6"));
  await user.click(within(key).getByRole("button", { name: "Copy the key" }));
  await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("sk-abcdefteam-6"));
  expect(key.textContent).not.toContain("sk-abcdefteam-6");
});

test("the Endpoint sheet says how the key is sent in the Endpoint dialog's words", async () => {
  renderWithSheets(null, "/x?sheet=endpoint:acme/main");
  const ep = await loadedSheet("Endpoint main");
  expect(within(ep).getByText("Key sent as")).toBeTruthy();
  expect(ep.textContent).toContain("Authorization: Bearer <key>");
  expect(ep.textContent).not.toMatch(/credential/i);
});

test("enable/disable and Test act on the record and show the result in the sheet", async () => {
  const user = userEvent.setup();
  routes["PATCH /api/providers/acme/keys/team-6"] = { upstream_key: {} };
  routes["POST /api/providers/acme/keys/bulk/test"] = {
    passed: 1,
    failed: 0,
    items: [{ index: 0, ok: true, result: { passed: true, status: 200, duration_ms: 420 } }],
  };
  const { fetch } = renderWithSheets(null, "/x?sheet=key:acme/team-6");
  const key = await screen.findByRole("dialog", { name: "Upstream Key team-6" });
  await user.click(await within(key).findByRole("button", { name: "Disable team-6" }));
  await waitFor(() => expect(fetch.mock.calls.some(([u, i]) => i?.method === "PATCH" && String(u) === "/api/providers/acme/keys/team-6")).toBe(true));
  const patch = fetch.mock.calls.find(([, i]) => i?.method === "PATCH")!;
  expect(JSON.parse(String(patch[1]!.body))).toEqual({ enabled: false });

  await user.click(within(key).getByRole("button", { name: "Test team-6" }));
  expect(await within(key).findByText(/^team-6 passed: 200/, { ignore: "script, style, [data-ui-sdk-announcer]" })).toBeTruthy();
});
