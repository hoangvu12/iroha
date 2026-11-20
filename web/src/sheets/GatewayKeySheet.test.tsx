import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgent } from "@ui-sdk/react/agent";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadedSheet, renderWithSheets, routes } from "./test-iroha";

// UI ticket 33: a Gateway Key's access is edited in its sheet (the key's own
// page keeps its dialog), and the models a scope narrows to link to their sheets.

const agent = createAgent();
const text = { ignore: "script, style, [data-ui-sdk-announcer]" };
const saved = { ...routes };
const key = routes["GET /api/gateway-keys/gk_1"] as { scope: object };
const narrowed = { ...key, scope: { all: false, providers: [{ provider: "acme", models: ["gpt-fast", "meta/llama-3"] }], pools: ["fast"] } };

beforeEach(() => {
  routes["GET /api/gateway-keys/gk_1"] = narrowed;
  routes["GET /api/providers"] = { providers: [{ id: "p1", handle: "acme", name: "Acme AI", enabled: true, archived: false }] };
  routes["GET /api/pools"] = { pools: [{ id: "pl1", name: "fast", maker: "openai" }] };
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of Object.keys(routes)) if (!(k in saved)) delete routes[k];
  Object.assign(routes, saved);
});

async function keySheet() {
  const sheet = await loadedSheet("Gateway Key zeron");
  await within(sheet).findByRole("button", { name: "Test as zeron" });
  return sheet;
}

const sent = (fetch: ReturnType<typeof renderWithSheets>["fetch"], method: string) =>
  fetch.mock.calls.filter(([, i]) => i?.method === method).map(([u, i]) => [String(u), i?.body ? JSON.parse(String(i.body)) : undefined]);

test("the models a key is narrowed to are links to their sheets", async () => {
  renderWithSheets(null, "/x?sheet=gateway-key:gk_1");
  const s = within(await keySheet());
  expect(s.getByRole("link", { name: "gpt-fast" }).getAttribute("href")).toBe("/x?sheet=gateway-key%3Agk_1&sheet=model%3Aacme%2Fgpt-fast");
  expect(s.getByRole("link", { name: "meta/llama-3" }).getAttribute("href")).toContain("sheet=model%3Aacme%2Fmeta%2Fllama-3");
});

test("Edit access turns the sheet's access into the editor; Save changes it and says so in the sheet", async () => {
  const user = userEvent.setup();
  routes["PATCH /api/gateway-keys/gk_1"] = { audit_entry: "aud_1", changes: [], gateway_key: narrowed };
  const { fetch } = renderWithSheets(null, "/x?sheet=gateway-key:gk_1");
  const sheet = await keySheet();
  const s = within(sheet);
  await user.click(s.getByRole("button", { name: "Edit access" }));
  expect(await s.findByRole("radiogroup", { name: "Access" })).toBeTruthy();
  // In the sheet, not a dialog over it.
  expect(screen.queryAllByRole("dialog")).toEqual([sheet]);
  await user.click(await s.findByRole("checkbox", { name: "fast" }));
  await user.click(s.getByRole("button", { name: "Save access" }));
  await waitFor(() => expect(sent(fetch, "PATCH")).toHaveLength(1));
  expect(sent(fetch, "PATCH")[0]).toEqual(["/api/gateway-keys/gk_1", { scope: { all: false, providers: [{ provider: "acme", models: ["gpt-fast", "meta/llama-3"] }], pools: [] } }]);
  expect(await s.findByText("Access of zeron changed", text)).toBeTruthy();
  await waitFor(() => expect(s.queryByRole("radiogroup", { name: "Access" })).toBeNull());
});

test("Cancel leaves the access as it was; nothing at all asks for a choice first", async () => {
  const user = userEvent.setup();
  const { fetch } = renderWithSheets(null, "/x?sheet=gateway-key:gk_1");
  const s = within(await keySheet());
  await user.click(s.getByRole("button", { name: "Edit access" }));
  await user.click(await s.findByRole("checkbox", { name: "fast" }));
  await user.click(s.getByRole("checkbox", { name: "acme" }));
  await user.click(s.getByRole("button", { name: "Save access" }));
  expect(await s.findByRole("alert")).toBeTruthy();
  expect(sent(fetch, "PATCH")).toHaveLength(0);
  await user.click(s.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(s.queryByRole("radiogroup", { name: "Access" })).toBeNull());
  expect(s.getByRole("link", { name: "fast" })).toBeTruthy();
});

test("a revoked key's access can't be edited", async () => {
  routes["GET /api/gateway-keys/gk_1"] = { ...narrowed, revoked: true, revoked_at: "2026-11-19T11:00:00Z" };
  renderWithSheets(null, "/x?sheet=gateway-key:gk_1");
  const sheet = await loadedSheet("Gateway Key zeron");
  await within(sheet).findByRole("heading", { name: "Access" });
  expect(within(sheet).queryByRole("button", { name: "Edit access" })).toBeNull();
});

test("an agent edits a key's access from its sheet by names alone", async () => {
  routes["PATCH /api/gateway-keys/gk_1"] = { audit_entry: "aud_1", changes: [], gateway_key: narrowed };
  const { fetch } = renderWithSheets(null, "/x?sheet=gateway-key:gk_1");
  const sheet = await keySheet();
  const edit = await agent.act({ steps: [{ ref: "Edit access", action: "press" }] });
  expect(edit.ok, edit.error?.message).toBe(true);
  await within(sheet).findByRole("radiogroup", { name: "Access" });
  const labels = agent.snapshot().filter((e) => !e.offPage).map((e) => e.label);
  for (const l of ["Access", "Save access", "Cancel"]) expect(labels, `${l} is missing`).toContain(l);
  const run = await agent.act({ steps: [{ ref: "Access", action: "setValue", args: ["all"] }, { ref: "Save access", action: "press" }] });
  expect(run.ok, run.error?.message).toBe(true);
  await waitFor(() => expect(sent(fetch, "PATCH")).toEqual([["/api/gateway-keys/gk_1", { scope: { all: true } }]]));
});
