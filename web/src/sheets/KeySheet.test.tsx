import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgent } from "@ui-sdk/react/agent";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Provider, UpstreamKey } from "@/pages/providers/api";
import { KeysTab } from "@/pages/providers/Keys";
import { loadedSheet, renderWithSheets, routes } from "./test-iroha";

let approve = false;
const agent = createAgent({ allow: (step) => !step.confirm || approve });

const where = () => screen.getByRole("status", { name: "Location" }).textContent;
const text = { ignore: "script, style, [data-ui-sdk-announcer]" };
const saved = { ...routes };

const provider = routes["GET /api/providers/acme"] as Provider;
const base = (routes["GET /api/providers/acme/keys/team-6"] as UpstreamKey);
const team7: UpstreamKey = {
  ...base,
  id: "k-team-7",
  name: "team-7",
  last_used_at: "2026-11-19T09:00:00Z",
  endpoints: ["main"],
  worked_on: [{ endpoint_id: "e1", endpoint: "main", succeeded_at: "2026-11-19T10:00:00Z" }],
  endpoint_gaps: [{ endpoint_id: "e2", endpoint: "intl", reason: "404 page", created_at: "2026-11-19T10:00:00Z" }],
  model_gaps: [{ model: "gpt-old", reason: "404 model_not_found", created_at: "2026-11-19T10:00:00Z", expires_at: "2026-11-26T10:00:00Z" }],
  state: { state: "cooling", reason: "429 Too Many Requests", rule: "rate-limit", until: "2099-01-01T00:00:00Z", request_id: "req_1" } as UpstreamKey["state"],
};
const done = (o: object = {}) => ({ audit_entry: "aud_1", upstream_key: team7, ...o });

beforeEach(() => {
  const intl = { ...(routes["GET /api/providers/acme/endpoints/main"] as object), id: "e2", name: "intl", url: "https://intl.acme.test/v1" };
  routes["GET /api/providers/acme"] = { ...provider, endpoints: [...provider.endpoints, intl] };
  routes["GET /api/providers/acme/keys/team-7"] = team7;
  routes["GET /api/providers/acme/endpoints/intl"] = intl;
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of Object.keys(routes)) if (!(k in saved)) delete routes[k];
  Object.assign(routes, saved);
  approve = false;
});

async function keySheet(name: string) {
  const sheet = await loadedSheet(`Upstream Key ${name}`);
  await within(sheet).findByRole("button", { name: `Test ${name}` });
  return sheet;
}

const calls = (fetch: ReturnType<typeof renderWithSheets>["fetch"], method: string) =>
  fetch.mock.calls.filter(([, i]) => i?.method === method).map(([u, i]) => [String(u), i?.body ? JSON.parse(String(i.body)) : undefined]);

test("the key's sheet shows what its dialog did: state, key, name, gaps, Endpoints, dates and actions", async () => {
  const user = userEvent.setup();
  renderWithSheets(null, "/x?sheet=key:acme/team-7");
  const sheet = await keySheet("team-7");
  const s = within(sheet);

  expect(sheet.textContent).toContain("429 Too Many Requests");
  expect(sheet.textContent).toContain("Rule: rate-limit");
  expect(s.getByRole("link", { name: "Open the Request" }).getAttribute("href")).toBe("/x?sheet=key%3Aacme%2Fteam-7&sheet=request%3Areq_1");

  expect(sheet.textContent).not.toContain("sk-abcdefteam-6");
  await user.click(s.getByRole("button", { name: "Show the key" }));
  expect(sheet.textContent).toContain("sk-abcdefteam-6");
  await user.click(s.getByRole("button", { name: "Hide the key" }));
  expect(sheet.textContent).not.toContain("sk-abcdefteam-6");
  expect(s.getByRole("button", { name: "Copy the key" })).toBeTruthy();
  expect(s.getByRole("button", { name: "Replace" })).toBeTruthy();

  expect((s.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("team-7");
  expect(sheet.textContent).toContain("gpt-old");
  expect(s.getByRole("button", { name: "Clear the Model Gap for gpt-old" })).toBeTruthy();
  expect(s.getAllByRole("link", { name: "main" }).length).toBeGreaterThan(0);
  expect(s.getByRole("link", { name: "intl" })).toBeTruthy();
  expect(s.getByRole("button", { name: "Clear the Endpoint Gap on intl" })).toBeTruthy();
  expect(s.getByRole("button", { name: "Restrict to working Endpoints" })).toBeTruthy();
  expect(await s.findByRole("button", { name: "Change the Endpoints of team-7" })).toBeTruthy();
  expect(s.getByText("Added")).toBeTruthy();
  expect(s.getByText("Last used")).toBeTruthy();

  for (const name of ["Test team-7", "Disable team-7", "Test team-7 in Chat", "Delete team-7…"]) expect(s.getByRole("button", { name })).toBeTruthy();
  expect(s.getByRole("button", { name: "Delete team-7…" }).hasAttribute("data-danger")).toBe(true);
});

test("Replace saves a new secret and Rename renames the key, which the sheet and the URL follow", async () => {
  const user = userEvent.setup();
  routes["PATCH /api/providers/acme/keys/team-7"] = done({ upstream_key: { ...team7, name: "team-7b" } });
  routes["GET /api/providers/acme/keys/team-7b"] = { ...team7, name: "team-7b" };
  const { fetch } = renderWithSheets(null, "/x?sheet=key:acme/team-7");
  const sheet = await keySheet("team-7");
  const s = within(sheet);

  await user.click(s.getByRole("button", { name: "Replace" }));
  await user.type(await s.findByRole("textbox", { name: "New key" }), "sk-new-secret");
  await user.click(s.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(calls(fetch, "PATCH")).toEqual([["/api/providers/acme/keys/team-7", { secret: "sk-new-secret" }]]));
  expect(await s.findByText("Key replaced", text)).toBeTruthy();

  const name = s.getByRole("textbox", { name: "Name" });
  await user.clear(name);
  await user.type(name, "team-7b");
  await user.click(s.getByRole("button", { name: "Rename" }));
  await waitFor(() => expect(calls(fetch, "PATCH")[1]).toEqual(["/api/providers/acme/keys/team-7", { name: "team-7b" }]));
  await waitFor(() => expect(where()).toBe("/x?sheet=key:acme/team-7b"));
  expect(await screen.findByRole("dialog", { name: "Upstream Key team-7b" })).toBe(sheet);
});

test("gaps clear one at a time, Restrict to working Endpoints and Test show their result in the sheet", async () => {
  const user = userEvent.setup();
  routes["POST /api/providers/acme/keys/team-7/clear-model-gaps"] = done();
  routes["POST /api/providers/acme/keys/team-7/clear-endpoint-gaps"] = done();
  routes["POST /api/providers/acme/keys/team-7/restrict-to-working-endpoints"] = done();
  routes["POST /api/providers/acme/keys/bulk/test"] = {
    passed: 0,
    failed: 1,
    items: [{ index: 0, ok: true, result: { passed: false, status: 401, reason: "invalid api key", action: "Marked invalid", rule: "auth", duration_ms: 90 } }],
  };
  const { fetch } = renderWithSheets(null, "/x?sheet=key:acme/team-7");
  const s = within(await keySheet("team-7"));

  await user.click(s.getByRole("button", { name: "Clear the Model Gap for gpt-old" }));
  expect(await s.findByText("Model Gap for gpt-old cleared", text)).toBeTruthy();
  await user.click(s.getByRole("button", { name: "Clear the Endpoint Gap on intl" }));
  expect(await s.findByText("Endpoint Gap on intl cleared", text)).toBeTruthy();
  await user.click(s.getByRole("button", { name: "Restrict to working Endpoints" }));
  expect(await s.findByText("team-7 restricted to the Endpoints it works on", text)).toBeTruthy();
  const posted = fetch.mock.calls.filter(([, i]) => i?.method === "POST").map(([u]) => String(u));
  expect(posted).toEqual([
    "/api/providers/acme/keys/team-7/clear-model-gaps?model=gpt-old",
    "/api/providers/acme/keys/team-7/clear-endpoint-gaps?endpoint=intl",
    "/api/providers/acme/keys/team-7/restrict-to-working-endpoints",
  ]);

  await user.click(s.getByRole("button", { name: "Test team-7" }));
  expect(await s.findByText("team-7 failed: 401 invalid api key", text)).toBeTruthy();
  await user.click(s.getByRole("button", { name: "Details" }));
  const results = await screen.findByRole("dialog", { name: "Tested 1 key" });
  expect(results.textContent).toContain("Marked invalid");
});

test("Saving the Endpoints picker updates the key by name with PUT", async () => {
  const user = userEvent.setup();
  routes["PUT /api/providers/acme/keys/bulk"] = { audit_entry: "aud_3", succeeded: 1, failed: 0, items: [{ index: 0, ok: true, outcome: "updated", changes: [] }] };
  const { fetch } = renderWithSheets(null, "/x?sheet=provider:acme&sheet=key:acme/team-7");
  const s = within(await keySheet("team-7"));
  await user.click(await s.findByRole("button", { name: "Change the Endpoints of team-7" }));
  const picker = await screen.findByRole("dialog", { name: "Endpoints for team-7" });
  await user.click(within(picker).getByRole("checkbox", { name: "intl" }));
  await user.click(within(picker).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(calls(fetch, "PUT")).toEqual([["/api/providers/acme/keys/bulk", { items: [{ name: "team-7", endpoints: [] }] }]]));
  expect(calls(fetch, "POST")).toEqual([]);
});

test("Change opens the Endpoints picker for the key; Delete… asks, then the key's sheet closes", async () => {
  const user = userEvent.setup();
  routes["POST /api/providers/acme/keys/bulk/delete"] = { audit_entry: "aud_2", succeeded: 1, failed: 0, items: [{ index: 0, ok: true, outcome: "deleted" }] };
  const { fetch } = renderWithSheets(null, "/x?sheet=provider:acme&sheet=key:acme/team-7");
  const sheet = await keySheet("team-7");
  const s = within(sheet);

  await user.click(await s.findByRole("button", { name: "Change the Endpoints of team-7" }));
  const picker = await screen.findByRole("dialog", { name: "Endpoints for team-7" });
  expect((within(picker).getByRole("checkbox", { name: "main" }) as HTMLInputElement).getAttribute("aria-checked")).toBe("true");
  await user.click(within(picker).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Endpoints for team-7" })).toBeNull());

  await user.click(s.getByRole("button", { name: "Delete team-7…" }));
  const ask = await screen.findByRole("alertdialog", { name: "Delete team-7?" });
  await user.click(within(ask).getByRole("button", { name: "Delete key" }));
  await waitFor(() => expect(calls(fetch, "POST")).toEqual([["/api/providers/acme/keys/bulk/delete", { items: ["team-7"] }]]));
  await waitFor(() => expect(where()).toBe("/x?sheet=provider:acme"));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Upstream Key team-7" })).toBeNull());
});

test("the Keys tab opens a key's sheet from its row, and an old ?key= link opens the sheet", async () => {
  const user = userEvent.setup();
  renderWithSheets(<KeysTab handle="acme" provider={provider} adding={false} setAdding={() => {}} />, "/providers/acme/keys?state=all&key=team-7");
  await keySheet("team-7");
  await waitFor(() => expect(where()).toBe("/providers/acme/keys?state=all&sheet=key:acme/team-7"));
  expect(screen.queryByRole("dialog", { name: "team-7" })).toBeNull();

  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryAllByRole("dialog")).toHaveLength(0));
  const table = await screen.findByRole("table", { name: "Upstream Keys" });
  await user.click(within(table).getByText("team-6"));
  await loadedSheet("Upstream Key team-6");
  await waitFor(() => expect(where()).toBe("/providers/acme/keys?state=all&sheet=key:acme/team-6"));
});

test("an agent reads a key's sheet by name, disables the key, and needs a person to delete it", async () => {
  routes["PATCH /api/providers/acme/keys/team-7"] = done({ upstream_key: { ...team7, enabled: false } });
  const { fetch } = renderWithSheets(null, "/x?sheet=key:acme/team-7");
  await keySheet("team-7");
  const entries = agent.snapshot().filter((e) => !e.offPage && e.component !== "more" && e.component !== "scroll-area");
  for (const e of entries) expect(e.label, `${e.component} ${e.ref} has no name`).toBeTruthy();
  const labels = entries.map((e) => e.label);
  for (const l of ["Test team-7", "Disable team-7", "Test team-7 in Chat", "Delete team-7…", "Show the key", "Copy the key", "Replace", "Name", "Open page"])
    expect(labels, `${l} is missing`).toContain(l);

  const run = await agent.act({ steps: [{ ref: "Disable team-7", action: "press" }] });
  expect(run.ok, run.error?.message).toBe(true);
  await waitFor(() => expect(calls(fetch, "PATCH")).toEqual([["/api/providers/acme/keys/team-7", { enabled: false }]]));

  const remove = { steps: [{ ref: "Delete team-7…", action: "press" }, { ref: "Delete team-7?", action: "press", args: ["Delete key"] }] };
  expect((await agent.act(remove)).ok).toBe(false);
  expect(calls(fetch, "POST").some(([u]) => String(u).endsWith("/delete"))).toBe(false);
});
