import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgent } from "@ui-sdk/react/agent";
import { Route, Routes } from "react-router";
import { afterEach, expect, test, vi } from "vitest";
import type { AuditEntry, Change } from "@/api/types";
import { KeyPage } from "@/pages/gateway-keys/KeyPage";
import { AuditEntriesTab } from "@/pages/settings/AuditEntries";
import { Reply } from "@/pages/chat/Reply";
import type { AssistantTurn } from "@/pages/chat/store";
import type { Pool, Provider, UpstreamKey } from "@/pages/providers/api";
import { KeysTab } from "@/pages/providers/Keys";
import { PoolMembersTab } from "@/pages/providers/PoolMembers";
import { PoolRouteTab } from "@/pages/providers/PoolRoute";
import { loadedSheet, renderWithSheets, routes } from "./test-iroha";

// UI ticket 11: wherever a record names another, the name is a RecordLink
// that opens its sheet (and whose href is the URL with that sheet open).

afterEach(() => vi.unstubAllGlobals());

const where = () => screen.getByRole("status", { name: "Location" }).textContent;
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
routes["GET /api/requests/req_3"] = { ...req1, id: "req_3", upstream_key: "team-6", attempt_count: 2, attempts: [attempt(1, "team-5", 429), attempt(2, "team-6", 200)] };

test("the Request sheet names its Gateway Key by name, linked to the key's sheet", async () => {
  renderWithSheets(null, "/requests?sheet=request:req_1");
  const request = await screen.findByRole("dialog", { name: "Request fast" });
  const gk = await within(request).findByRole("link", { name: "zeron" });
  expect(hrefOf(gk)).toBe("/requests?sheet=request:req_1&sheet=gateway-key:gk_1");
  expect(within(request).queryByText("gk_1")).toBeNull();
  await userEvent.setup().click(gk);
  await screen.findByRole("dialog", { name: "Gateway Key zeron" });
});

test("each Attempt links its Upstream Key, Provider and Endpoint", async () => {
  const user = userEvent.setup();
  renderWithSheets(null, "/requests?sheet=request:req_3/attempts");
  const request = await screen.findByRole("dialog", { name: "Request fast" });
  // The first Attempt failed, so its facts are open; its key is a link in the card's header too.
  const keys = await within(request).findAllByRole("link", { name: "team-5" });
  expect(keys.length).toBeGreaterThanOrEqual(2);
  expect(hrefOf(keys[0])).toBe("/requests?sheet=request:req_3/attempts&sheet=key:acme/team-5");
  expect(within(request).getAllByRole("link", { name: "main" }).length).toBeGreaterThanOrEqual(1);
  expect(hrefOf(within(request).getAllByRole("link", { name: "acme" })[0])).toBe("/requests?sheet=request:req_3/attempts&sheet=provider:acme");
  // The header still opens and closes the Attempt.
  const toggle = within(request).getByRole("button", { name: "Attempt 2" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  await user.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");

  await user.click(keys[0]);
  await screen.findByRole("dialog", { name: "Upstream Key team-5" });
  await waitFor(() => expect(where()).toBe("/requests?sheet=request:req_3/attempts&sheet=key:acme/team-5"));
});

const fastPool = routes["GET /api/pools/fast"] as Pool;
routes["GET /api/route-preview"] = {
  model: "fast",
  pool: "fast",
  shape: "openai-chat",
  at: "2026-11-19T10:00:00Z",
  ready: 1,
  budget: {},
  members: [
    {
      position: 1,
      provider: "acme",
      model: "gpt-fast",
      enabled: true,
      planned: true,
      keys: 2,
      ready_keys: 1,
      candidates: [{ endpoint: "main", upstream_key: "team-6", wire_model: "gpt-fast", shape: "openai-chat", translated: false, carrier: false }],
      skipped: [{ upstream_key: "team-5", reason: "cooling", seconds_left: 60 }],
    },
  ],
};
routes["GET /api/overview"] = { since: "2026-11-19T00:00:00Z", providers: [], pools: [] };
routes["GET /api/gateway-keys"] = { gateway_keys: [routes["GET /api/gateway-keys/gk_1"]] };

test("a Pool's route preview links each member's Provider, its Endpoints and its keys", async () => {
  renderWithSheets(<PoolRouteTab name="fast" pool={fastPool} onAdd={() => {}} />, "/providers/pools/fast/route");
  const route = await screen.findByRole("group", { name: "Route of fast" });
  // The member's card names its Provider as a link; the card selects the member.
  const card = await within(route).findByRole("link", { name: "acme" });
  expect(hrefOf(card)).toBe("/providers/pools/fast/route?sheet=provider:acme");
  expect(within(route).getByRole("button", { name: "Member 1" }).getAttribute("aria-pressed")).toBe("true");

  const panel = screen.getByRole("region", { name: "Selected step" });
  expect(hrefOf(within(panel).getByRole("link", { name: "main" }))).toBe("/providers/pools/fast/route?sheet=endpoint:acme/main");
  expect(hrefOf(within(panel).getByRole("link", { name: "team-5" }))).toBe("/providers/pools/fast/route?sheet=key:acme/team-5");
  expect(hrefOf(within(panel).getByRole("link", { name: "team-6" }))).toBe("/providers/pools/fast/route?sheet=key:acme/team-6");

  await userEvent.setup().click(within(panel).getByRole("link", { name: "team-6" }));
  await screen.findByRole("dialog", { name: "Upstream Key team-6" });
});

test("a Pool's members link their Provider and the Gateway Keys that can use it", async () => {
  renderWithSheets(<PoolMembersTab name="fast" pool={fastPool} onAdd={() => {}} />, "/providers/pools/fast/members");
  const table = await screen.findByRole("table", { name: "Members of fast" });
  expect(hrefOf(await within(table).findByRole("link", { name: "acme" }))).toBe("/providers/pools/fast/members?sheet=provider:acme");
  const zeron = await screen.findByRole("link", { name: "zeron" });
  expect(hrefOf(zeron)).toBe("/providers/pools/fast/members?sheet=gateway-key:gk_1");
  await userEvent.setup().click(zeron);
  await screen.findByRole("dialog", { name: "Gateway Key zeron" });
});

test("a Gateway Key's access links each Provider and Pool it grants", async () => {
  const page = (
    <Routes>
      <Route path="/gateway-keys/:key" element={<KeyPage />} />
    </Routes>
  );
  renderWithSheets(page, "/gateway-keys/gk_1");
  const acme = await screen.findByRole("link", { name: "acme" });
  expect(hrefOf(acme)).toBe("/gateway-keys/gk_1?sheet=provider:acme");
  expect(hrefOf(screen.getByRole("link", { name: "fast" }))).toBe("/gateway-keys/gk_1?sheet=pool:fast");
  await userEvent.setup().click(acme);
  await screen.findByRole("dialog", { name: "Provider acme" });
});

const auditEntry = (id: string, summary: string, changes: Change[]): AuditEntry => ({
  id,
  time: "2026-11-19T10:00:00Z",
  actor: { kind: "owner_session", id: "os_1", name: "Owner" },
  action: "update",
  summary,
  revertible: true,
  changes,
});
const change = (resource: string, id: string, name: string): Change => ({ resource, id, name, op: "update", fields: ["enabled"], before: { enabled: true }, after: { enabled: false } });
routes["GET /api/audit-entries/filters"] = { actors: [], resources: [] };
routes["GET /api/audit-entries"] = {
  entries: [
    auditEntry("ae_1", "Upstream Key acme/team-5 disabled", [change("upstream_key", "k-team-5", "acme/team-5")]),
    auditEntry("ae_2", "Gateway Key zeron renamed", [change("gateway_key", "gk_1", "zeron")]),
    auditEntry("ae_3", "Endpoint acme/main changed", [change("endpoint", "e1", "acme/main")]),
    auditEntry("ae_4", "2 keys disabled", [change("upstream_key", "k-team-5", "acme/team-5"), change("upstream_key", "k-team-6", "acme/team-6")]),
    auditEntry("ae_5", "Model Gap cleared", [change("model_gap", "g1", "acme/team-6/gpt-x")]),
    auditEntry("ae_6", "Admin Token ci created", [change("admin_token", "at_1", "ci")]),
  ],
};

test("an Audit Entry links the record it changed", async () => {
  const user = userEvent.setup();
  renderWithSheets(<AuditEntriesTab />, "/settings/audit-entries");
  const table = await screen.findByRole("table", { name: "Audit Entries" });
  const at = "/settings/audit-entries?sheet=";
  expect(hrefOf(within(table).getByRole("link", { name: "acme/team-5" }))).toBe(at + "key:acme/team-5");
  expect(hrefOf(within(table).getByRole("link", { name: "zeron" }))).toBe(at + "gateway-key:gk_1");
  expect(hrefOf(within(table).getByRole("link", { name: "acme/main" }))).toBe(at + "endpoint:acme/main");
  // Several keys of one Provider: the Provider.
  expect(hrefOf(within(table).getByRole("link", { name: "acme" }))).toBe(at + "provider:acme");
  // A Model Gap belongs to its Upstream Key.
  expect(hrefOf(within(table).getByRole("link", { name: "acme/team-6/gpt-x" }))).toBe(at + "key:acme/team-6");
  // An Admin Token has no sheet.
  expect(within(table).queryByRole("link", { name: "ci" })).toBeNull();

  // The opened entry names each record it changed as a link too.
  await user.click(within(table).getByRole("button", { name: /^Show details of 2 keys disabled/ }));
  expect(hrefOf(await within(table).findByRole("link", { name: "acme/team-6" }))).toBe(at + "key:acme/team-6");

  await user.click(within(table).getByRole("link", { name: "zeron" }));
  await screen.findByRole("dialog", { name: "Gateway Key zeron" });
  // Following the link didn't open or close the row.
  expect(within(table).getAllByRole("button", { name: /^Show details of/ }).length).toBe(5);
});

test("a chat reply's details link the key and Endpoint that served it", async () => {
  const user = userEvent.setup();
  const turn: AssistantTurn = {
    id: "t1",
    role: "assistant",
    model: "acme/gpt-fast",
    shape: "openai-chat",
    rounds: [{ requestId: "req_1", status: "done", parts: [{ kind: "text", text: "Hello." }] }],
  };
  renderWithSheets(<Reply turn={turn} />, "/chat");
  await user.click(screen.getByRole("button", { name: "Details" }));
  const key = await screen.findByRole("link", { name: "team-5" });
  expect(hrefOf(key)).toBe("/chat?sheet=key:acme/team-5");
  expect(hrefOf(screen.getByRole("link", { name: "main" }))).toBe("/chat?sheet=endpoint:acme/main");
  await user.click(key);
  await screen.findByRole("dialog", { name: "Upstream Key team-5" });
});

test("an Upstream Key's sheet links its Endpoints, gaps and Request; following one opens its sheet above, and Back closes it", async () => {
  const user = userEvent.setup();
  const provider = routes["GET /api/providers/acme"] as Provider;
  const keys = (routes["GET /api/providers/acme/keys"] as { upstream_keys: UpstreamKey[] }).upstream_keys;
  const team7: UpstreamKey = {
    ...keys[1],
    id: "k-team-7",
    name: "team-7",
    endpoints: ["main"],
    worked_on: [{ endpoint_id: "e1", endpoint: "main", succeeded_at: "2026-11-19T10:00:00Z" }],
    endpoint_gaps: [{ endpoint_id: "e2", endpoint: "intl", reason: "404 page", created_at: "2026-11-19T10:00:00Z" }],
    state: { state: "cooling", reason: "429", until: "2099-01-01T00:00:00Z", request_id: "req_1" } as UpstreamKey["state"],
  };
  routes["GET /api/providers/acme/keys"] = { upstream_keys: [...keys, team7] };
  routes["GET /api/providers/acme/keys/team-7"] = team7;
  routes["GET /api/providers/acme/endpoints/intl"] = { ...(routes["GET /api/providers/acme/endpoints/main"] as object), id: "e2", name: "intl" };

  // The old link (?key=) opens the key's sheet (UI ticket 27; it was a dialog).
  const { router } = renderWithSheets(<KeysTab handle="acme" provider={provider} adding={false} setAdding={() => {}} />, "/providers/acme/keys?key=team-7");
  const sheet = await loadedSheet("Upstream Key team-7");
  const intl = await within(sheet).findByRole("link", { name: "intl" });
  await waitFor(() => expect(where()).toBe("/providers/acme/keys?sheet=key:acme/team-7"));
  // The key's Endpoints and its Endpoint Gaps; the Request that set its state.
  expect(hrefOf(within(sheet).getByRole("link", { name: "main" }))).toBe("/providers/acme/keys?sheet=key:acme/team-7&sheet=endpoint:acme/main");
  expect(hrefOf(intl)).toBe("/providers/acme/keys?sheet=key:acme/team-7&sheet=endpoint:acme/intl");
  expect(hrefOf(within(sheet).getByRole("link", { name: "Open the Request" }))).toBe("/providers/acme/keys?sheet=key:acme/team-7&sheet=request:req_1");

  await user.click(intl);
  await loadedSheet("Endpoint intl");
  await waitFor(() => expect(where()).toBe("/providers/acme/keys?sheet=key:acme/team-7&sheet=endpoint:acme/intl"));
  expect(sheet.hasAttribute("data-top")).toBe(false);

  // Back closes the Endpoint's sheet; the key's is on top again.
  await router.navigate(-1);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Endpoint intl" })).toBeNull());
  await waitFor(() => expect(where()).toBe("/providers/acme/keys?sheet=key:acme/team-7"));
  expect(sheet.hasAttribute("data-top")).toBe(true);
});

test("an agent finds an Attempt's toggle and its links by name, and follows one", async () => {
  const agent = createAgent();
  renderWithSheets(null, "/requests?sheet=request:req_3/attempts");
  const request = await screen.findByRole("dialog", { name: "Request fast" });
  await within(request).findAllByRole("link", { name: "team-5" });
  const entries = agent.snapshot().filter((e) => !e.offPage && e.component !== "more" && e.component !== "scroll-area");
  for (const e of entries) expect(e.label, `${e.component} ${e.ref} has no name`).toBeTruthy();
  const labels = entries.map((e) => e.label);
  for (const name of ["Attempt 1", "Attempt 2", "team-5", "team-6", "acme", "main"]) expect(labels).toContain(name);

  // The Attempt's header names its key too, so the link is pressed by its ref.
  const link = entries.find((e) => e.label === "team-6")!;
  const result = await agent.act({ steps: [{ ref: link.ref, action: "press" }] });
  expect(result.ok, result.error?.message).toBe(true);
  await screen.findByRole("dialog", { name: "Upstream Key team-6" });
  await waitFor(() => expect(where()).toBe("/requests?sheet=request:req_3/attempts&sheet=key:acme/team-6"));
});
