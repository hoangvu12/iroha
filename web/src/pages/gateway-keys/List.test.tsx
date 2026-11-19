import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createAgent } from "@ui-sdk/react/agent";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Toaster } from "@/ui/toast";
import type { GatewayKey } from "./api";
import { KeysList } from "./List";

// The Gateway Keys list on the shared DataTable (UI ticket 08): its columns'
// sort and search in the URL, the row menu's confirms and calls, and the
// Revoked Gateway Keys table under its disclosure.

let approve = false;
const agent = createAgent({ allow: (step) => !step.confirm || approve });
const { openChat } = vi.hoisted(() => ({ openChat: vi.fn() }));
vi.mock("@/app/chat-panel", () => ({ useChatActions: () => ({ open: openChat, close() {}, toggle() {} }) }));

const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

const gk = (i: number, o: Partial<GatewayKey> = {}): GatewayKey => ({
  id: `gk_${i}`,
  name: `caller-${i}`,
  secret: `iroha_gk_secret${String(i).padStart(4, "0")}`,
  scope: { all: true },
  capture: false,
  revoked: false,
  created_at: "2026-11-01T00:00:00Z",
  last_used_at: new Date(Date.UTC(2026, 10, 19, 9, i)).toISOString(),
  recent_requests: i * 10,
  ...o,
});

function Where() {
  const l = useLocation();
  return <output aria-label="Where">{l.pathname + l.search}</output>;
}

function renderList(keys: GatewayKey[], url = "/gateway-keys") {
  const fetch = vi.fn<typeof globalThis.fetch>(async (u, init) => {
    const path = String(u);
    const method = init?.method ?? "GET";
    if (path.startsWith("/api/gateway-keys") && method === "GET") return answer({ gateway_keys: keys });
    return answer({ audit_entry: "ae_1", changes: [], gateway_key: keys[0] });
  });
  vi.stubGlobal("fetch", fetch);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/gateway-keys" element={<KeysList />} />
          <Route path="*" element={null} />
        </Routes>
        <Where />
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  );
  return fetch;
}

const writes = (fetch: ReturnType<typeof renderList>) =>
  fetch.mock.calls.filter(([, init]) => (init?.method ?? "GET") !== "GET").map(([u, init]) => `${init?.method} ${String(u)}`);
const rows = (name = "Gateway Keys") => within(screen.getByRole("table", { name })).getAllByRole("row").slice(1);
const where = () => screen.getByLabelText("Where").textContent ?? "";

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  openChat.mockClear();
  approve = false;
});

test("active keys come in pages of 25 in natural name order; revoked keys are not among them", async () => {
  const user = userEvent.setup();
  renderList([...Array.from({ length: 30 }, (_, i) => gk(i + 1)), gk(99, { revoked: true, revoked_at: "2026-11-10T00:00:00Z" })]);
  await screen.findByRole("table", { name: "Gateway Keys" });
  expect(rows()).toHaveLength(25);
  expect(within(rows()[1]).getByText("caller-2")).toBeTruthy();
  expect(within(rows()[9]).getByText("caller-10")).toBeTruthy();
  expect(screen.queryByText("caller-99")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Page 2" }));
  expect(rows()).toHaveLength(5);
});

test("search and sort live in the URL: searching narrows the keys, Requests, 24 h sorts the busiest first", async () => {
  const user = userEvent.setup();
  renderList([gk(1), gk(2), gk(3)]);
  await screen.findByRole("table", { name: "Gateway Keys" });
  await user.type(screen.getByRole("searchbox", { name: "Search Gateway Keys by name or key" }), "caller-2");
  expect(rows()).toHaveLength(1);
  expect(where()).toContain("q=caller-2");
  await user.clear(screen.getByRole("searchbox", { name: "Search Gateway Keys by name or key" }));
  await user.click(screen.getByRole("button", { name: "Sort by Requests, 24 h" }));
  expect(where()).toContain("sort=requests");
  expect(within(rows()[0]).getByText("caller-3")).toBeTruthy();
});

test("a search that matches nothing names the search as a chip with Clear filters", async () => {
  const user = userEvent.setup();
  renderList([gk(1)], "/gateway-keys?q=nobody");
  expect(await screen.findByText("No Gateway Keys match")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(where()).toBe("/gateway-keys");
  expect(rows()).toHaveLength(1);
});

test("a row click, or Open <name>, opens the key's page", async () => {
  const user = userEvent.setup();
  renderList([gk(1), gk(2)]);
  await user.click(await screen.findByRole("link", { name: "Open caller-2" }));
  expect(where()).toBe("/gateway-keys/gk_2");
});

test("the row menu: Test as opens the chat sending as the key; Revoke… asks for the name typed, then revokes", async () => {
  const user = userEvent.setup();
  const fetch = renderList([gk(1), gk(2)]);
  await user.click(await screen.findByRole("button", { name: "More for caller-2" }));
  await user.click(await screen.findByRole("menuitem", { name: "Test as caller-2" }));
  expect(openChat).toHaveBeenCalledWith({ kind: "gateway_key", gatewayKey: "caller-2" });

  await user.click(screen.getByRole("button", { name: "More for caller-2" }));
  const revoke = await screen.findByRole("menuitem", { name: "Revoke…" });
  expect(revoke.hasAttribute("data-destructive")).toBe(true);
  await user.click(revoke);
  const dialog = await screen.findByRole("alertdialog", { name: "Revoke caller-2?" });
  const confirm = within(dialog).getByRole("button", { name: "Revoke key" });
  expect(confirm.hasAttribute("disabled") || confirm.getAttribute("aria-disabled") === "true" || confirm.hasAttribute("data-disabled")).toBe(true);
  await user.type(within(dialog).getByRole("textbox"), "caller-2");
  await user.click(within(dialog).getByRole("button", { name: "Revoke key" }));
  await waitFor(() => expect(writes(fetch)).toEqual(["POST /api/gateway-keys/gk_2/revoke"]));
});

test("Delete… in the row menu asks, naming the key; Cancel deletes nothing, Delete key does", async () => {
  const user = userEvent.setup();
  const fetch = renderList([gk(1)]);
  await user.click(await screen.findByRole("button", { name: "More for caller-1" }));
  await user.click(await screen.findByRole("menuitem", { name: "Delete…" }));
  await user.click(within(await screen.findByRole("alertdialog", { name: "Delete caller-1?" })).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(writes(fetch)).toEqual([]);
  await user.click(screen.getByRole("button", { name: "More for caller-1" }));
  await user.click(await screen.findByRole("menuitem", { name: "Delete…" }));
  await user.click(await screen.findByRole("button", { name: "Delete key" }));
  await waitFor(() => expect(writes(fetch)).toEqual(["DELETE /api/gateway-keys/gk_1"]));
});

test("revoked keys fold under Revoked keys into their own table, newest revoke first; Delete asks first", async () => {
  const user = userEvent.setup();
  const fetch = renderList([
    gk(1),
    gk(7, { revoked: true, revoked_at: "2026-11-02T00:00:00Z" }),
    gk(8, { revoked: true, revoked_at: "2026-11-12T00:00:00Z" }),
  ]);
  const toggle = await screen.findByRole("button", { name: /Revoked keys/ });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  await user.click(toggle);
  const revoked = await screen.findByRole("table", { name: "Revoked Gateway Keys" });
  expect(within(rows("Revoked Gateway Keys")[0]).getByText("caller-8")).toBeTruthy();
  const del = within(revoked).getByRole("button", { name: "Delete caller-7…" });
  expect(del.hasAttribute("data-danger")).toBe(true);
  await user.click(del);
  await user.click(within(await screen.findByRole("alertdialog", { name: "Delete caller-7?" })).getByRole("button", { name: "Delete key" }));
  await waitFor(() => expect(writes(fetch)).toEqual(["DELETE /api/gateway-keys/gk_7"]));
});

test("no keys at all: the empty state offers New key", async () => {
  renderList([]);
  expect(await screen.findByText("No Gateway Keys yet")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "New key" })).toHaveLength(2);
});

test("only revoked keys: the table says every key is revoked, and the revoked ones are still there", async () => {
  renderList([gk(4, { revoked: true, revoked_at: "2026-11-12T00:00:00Z" })]);
  expect(await screen.findByText("No active Gateway Keys")).toBeTruthy();
  expect(screen.getByRole("button", { name: /Revoked keys/ })).toBeTruthy();
});

test("an agent searches, sorts and opens a key's menu, and needs a person to revoke one", async () => {
  const fetch = renderList([gk(1), gk(2), gk(3, { revoked: true, revoked_at: "2026-11-12T00:00:00Z" })]);
  await screen.findByRole("table", { name: "Gateway Keys" });
  const entries = agent.snapshot().filter((e) => !e.offPage && e.component !== "more");
  for (const e of entries) expect(e.label, `${e.component} ${e.ref} has no name`).toBeTruthy();
  const labels = entries.map((e) => e.label);
  for (const l of ["Search Gateway Keys by name or key", "Sort by Name", "Sort by Last used", "Sort by Requests, 24 h", "More for caller-1", "Open caller-1", "New key"])
    expect(labels, `${l} is missing`).toContain(l);

  const run = await agent.act({ steps: [{ ref: "Sort by Last used", action: "press" }] });
  expect(run.ok, run.error?.message).toBe(true);
  expect(where()).toContain("sort=used");

  const revoke = {
    steps: [
      { ref: "More for caller-1", action: "press", args: ["Revoke…"] },
      { ref: "Revoke caller-1?", action: "press", args: ["Revoke key"] },
    ],
  };
  expect((await agent.act(revoke)).ok).toBe(false);
  expect(writes(fetch)).toEqual([]);
});
