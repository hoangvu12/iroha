import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createAgent } from "@ui-sdk/react/agent";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Toaster } from "@/ui/toast";
import type { Endpoint, Provider, UpstreamKey } from "./api";
import { SheetStackProvider } from "@/sheets/stack";
import { KeysTab } from "./Keys";

let approve = false;
const agent = createAgent({ allow: (step) => !step.confirm || approve });
const { openChat } = vi.hoisted(() => ({ openChat: vi.fn() }));
vi.mock("@/app/chat-panel", () => ({ useChatActions: () => ({ open: openChat, close() {}, toggle() {} }) }));

const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

const key = (i: number, o: Partial<UpstreamKey> = {}): UpstreamKey => ({
  id: `key_${i}`,
  provider: "acme",
  name: `team-${i}`,
  secret: `sk-secret${String(i).padStart(4, "0")}`,
  enabled: true,
  state: { state: "active" },
  cooling_models: [],
  model_gaps: [],
  endpoints: [],
  endpoint_gaps: [],
  worked_on: [],
  created_at: "2026-11-19T09:00:00Z",
  last_used_at: new Date(Date.UTC(2026, 10, 19, 9, i)).toISOString(),
  ...o,
});

function Where() {
  const l = useLocation();
  return <output aria-label="Where">{l.search}</output>;
}

type Group = { upstream_key_id: string; requests: number; input: number; cache_read: number };

function renderTab(
  keys: UpstreamKey[],
  url = "/providers/acme/keys",
  { provider, refuse = [], cache = [] }: { provider?: Provider; refuse?: number[]; cache?: Group[] } = {},
) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (u, init) => {
    const path = String(u);
    if (path.startsWith("/api/providers/acme/keys") && (init?.method ?? "GET") === "GET") return answer({ upstream_keys: keys });
    if (path.startsWith("/api/requests/stats"))
      return answer({
        requests: 0,
        cache_hits: 0,
        tokens: {},
        groups: cache.map((g) => ({
          provider: "acme",
          upstream_key_id: g.upstream_key_id,
          requests: g.requests,
          cache_hits: g.cache_read > 0 ? g.requests : 0,
          tokens: { input: g.input, output: 0, cache_read: g.cache_read, cache_write: 0, cache_write_long: 0, reasoning: 0, total: g.input },
        })),
      });
    const items: unknown[] = JSON.parse(String(init?.body ?? "{}")).items ?? [];
    const ok = (i: number) => !refuse.includes(i);
    return answer({
      dry_run: false,
      audit_entry: "aud_1",
      succeeded: items.filter((_, i) => ok(i)).length,
      failed: refuse.length,
      items: items.map((_, index) => (ok(index) ? { index, ok: true, outcome: "updated", changes: [] } : { index, ok: false, error: { code: "not_found", message: "No such key." }, changes: [] })),
    });
  });
  vi.stubGlobal("fetch", fetch);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <SheetStackProvider>
          <KeysTab handle="acme" provider={provider} adding={false} setAdding={() => {}} />
          <Where />
        </SheetStackProvider>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  );
  return fetch;
}

const posts = (fetch: ReturnType<typeof renderTab>) =>
  fetch.mock.calls.filter(([, init]) => init?.method === "POST").map(([u, init]) => [String(u), JSON.parse(String(init?.body))]);
const rows = () => within(screen.getByRole("table", { name: "Upstream Keys" })).getAllByRole("row").slice(1);
const where = () => screen.getByLabelText("Where").textContent ?? "";

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  openChat.mockClear();
  approve = false;
});

test("keys come in pages of 25 in natural order; 50 per page is remembered for the Keys table", async () => {
  const user = userEvent.setup();
  renderTab(Array.from({ length: 60 }, (_, i) => key(i + 1)));
  await screen.findByRole("table", { name: "Upstream Keys" });
  expect(rows()).toHaveLength(25);
  expect(within(rows()[0]).getByText("team-1")).toBeTruthy();
  expect(within(rows()[9]).getByText("team-10")).toBeTruthy();
  expect(screen.getByText(/60 keys/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Page 3" }));
  expect(rows()).toHaveLength(10);
  await user.click(screen.getByRole("combobox", { name: "Rows per page" }));
  await user.click(await screen.findByRole("option", { name: "50 per page" }));
  expect(rows()).toHaveLength(50);
  expect(localStorage.getItem("iroha:table:provider-keys:page-size")).toBe("50");
});

test("the state filter and search narrow the keys and live in the URL; sorting by State does too", async () => {
  const user = userEvent.setup();
  renderTab([key(1), key(2, { state: { state: "cooling", until: new Date(Date.now() + 40_000).toISOString() } }), key(3, { state: { state: "invalid" } })]);
  await screen.findByRole("table", { name: "Upstream Keys" });
  await user.click(screen.getByRole("radio", { name: /Cooling/ }));
  expect(rows()).toHaveLength(1);
  expect(where()).toContain("state=cooling");
  await user.click(screen.getByRole("radio", { name: /All/ }));
  await user.type(screen.getByRole("searchbox", { name: "Search keys by name or secret" }), "secret0003");
  expect(rows()).toHaveLength(1);
  expect(within(rows()[0]).getByText("team-3")).toBeTruthy();
  await user.clear(screen.getByRole("searchbox", { name: "Search keys by name or secret" }));
  await user.click(screen.getByRole("button", { name: "Sort by State" }));
  expect(where()).toContain("sort=state");
  expect(within(rows()[0]).getByText("team-3")).toBeTruthy(); // invalid first
});

test("Cached, 24 h: each key's cached share from the Requests of the last day, test Requests left out", async () => {
  const fetch = renderTab([key(1), key(2), key(3)], undefined, {
    cache: [
      { upstream_key_id: "key_1", requests: 12, input: 4000, cache_read: 1000 },
      { upstream_key_id: "key_3", requests: 3, input: 900, cache_read: 0 },
    ],
  });
  await screen.findByRole("table", { name: "Upstream Keys" });
  const at = within(screen.getByRole("table", { name: "Upstream Keys" }))
    .getAllByRole("columnheader")
    .findIndex((h) => h.textContent?.includes("Cached, 24 h"));
  expect(at).toBeGreaterThan(0);
  const cell = (i: number) => within(rows()[i]).getAllByRole("cell")[at];
  await waitFor(() => expect(cell(0)?.textContent).toBe("25.0%"));
  expect(cell(0)?.querySelector("[title]")?.getAttribute("title")).toBe("1,000 of 4,000 input tokens read from the cache, 12 Requests");
  expect(cell(1)?.textContent).toBe("–"); // no Requests in the last day
  expect(cell(2)?.textContent).toBe("0.0%");
  const asked = fetch.mock.calls.map(([u]) => new URL(String(u), "http://iroha.test")).find((u) => u.pathname === "/api/requests/stats")!;
  expect(Object.fromEntries(asked.searchParams)).toEqual({ provider: "acme", group_by: "upstream_key", since: "24h", caller_kind: "gateway_key" });
});

test("sorting by Cached, 24 h puts the best-cached key first and lives in the URL", async () => {
  const user = userEvent.setup();
  renderTab([key(1), key(2), key(3)], undefined, {
    cache: [
      { upstream_key_id: "key_1", requests: 2, input: 1000, cache_read: 100 },
      { upstream_key_id: "key_2", requests: 2, input: 1000, cache_read: 800 },
    ],
  });
  await screen.findByRole("table", { name: "Upstream Keys" });
  await waitFor(() => expect(within(rows()[1]).getByText("80.0%")).toBeTruthy());
  await user.click(screen.getByRole("button", { name: "Sort by Cached, 24 h" }));
  expect(rows().map((r) => within(r).getByText(/^team-/).textContent)).toEqual(["team-2", "team-1", "team-3"]);
  expect(where()).toContain("sort=cached");
});

test("selecting keys shows the bulk bar; Disable calls the bulk API and shows its result in the bar", async () => {
  const user = userEvent.setup();
  const fetch = renderTab([key(1), key(2), key(3)]);
  await user.click(await screen.findByRole("checkbox", { name: "Select team-1" }));
  await user.keyboard("{Shift>}");
  await user.click(screen.getByRole("checkbox", { name: "Select team-2" }));
  await user.keyboard("{/Shift}");
  const bar = screen.getByRole("group", { name: "2 selected" });
  await user.click(within(bar).getByRole("button", { name: "Disable" }));
  await waitFor(() => expect(posts(fetch)).toEqual([["/api/providers/acme/keys/bulk/disable", { items: ["team-1", "team-2"] }]]));
  expect(await within(bar).findByText("2 keys disabled", { ignore: "script, style, [data-ui-sdk-announcer]" })).toBeTruthy();
});

const endpoint = (name: string): Endpoint => ({
  id: `ep_${name}`,
  provider: "acme",
  name,
  url: `https://${name}.example.com/v1`,
  shape: "openai-chat",
  auth_style: "bearer",
  static_headers: {},
  renames: {},
  discovery_url: "",
  created_at: "2026-11-19T00:00:00Z",
});
const acme = { handle: "acme", endpoints: [endpoint("eu"), endpoint("us"), endpoint("asia")] } as Provider;

test("Edit… shows mixed values for the selected keys and sends one bulk update with only what changed: Endpoints as a change the server applies to each key's own list", async () => {
  const user = userEvent.setup();
  const fetch = renderTab([key(1, { endpoints: ["eu"] }), key(2, { enabled: false }), key(3)], undefined, { provider: acme });
  await user.click(await screen.findByRole("checkbox", { name: "Select all rows on this page" }));
  const bar = screen.getByRole("group", { name: "3 selected" });
  await user.click(within(bar).getByRole("button", { name: "Edit…" }));
  const dialog = await screen.findByRole("dialog", { name: "Edit 3 keys" });
  expect(within(dialog).getByRole("checkbox", { name: "Enabled" }).getAttribute("aria-checked")).toBe("mixed");
  // team-2 and team-3 may use every Endpoint, team-1 only eu.
  expect(within(dialog).getByRole("checkbox", { name: "eu" }).getAttribute("aria-checked")).toBe("true");
  expect(within(dialog).getByRole("checkbox", { name: "us" }).getAttribute("aria-checked")).toBe("mixed");
  // Take asia off every key; leave Enabled alone.
  await user.click(within(dialog).getByRole("checkbox", { name: "asia" }));
  await user.click(within(dialog).getByRole("checkbox", { name: "asia" }));
  await user.click(within(dialog).getByRole("button", { name: "Apply to 3 keys" }));
  await waitFor(() =>
    expect(posts(fetch)).toEqual([
      [
        "/api/providers/acme/keys/bulk/update",
        { items: [{ key: "key_1", endpoints_remove: ["asia"] }, { key: "key_2", endpoints_remove: ["asia"] }, { key: "key_3", endpoints_remove: ["asia"] }] },
      ],
    ]),
  );
  expect(await within(bar).findByText("3 keys changed", { ignore: "script, style, [data-ui-sdk-announcer]" })).toBeTruthy();
  expect(within(bar).getByRole("button", { name: "Undo: 3 keys changed" })).toBeTruthy();
});

test("ticking an Endpoint sends it to add, never a list built from the loaded rows, so a key's list changed since keeps that change", async () => {
  const user = userEvent.setup();
  // As loaded: team-1 on eu alone, team-2 on eu and asia. Either may have changed since.
  const fetch = renderTab([key(1, { endpoints: ["eu"] }), key(2, { endpoints: ["eu", "asia"] })], undefined, { provider: acme });
  await user.click(await screen.findByRole("checkbox", { name: "Select all rows on this page" }));
  const bar = screen.getByRole("group", { name: "2 selected" });
  await user.click(within(bar).getByRole("button", { name: "Edit…" }));
  const dialog = await screen.findByRole("dialog", { name: "Edit 2 keys" });
  await user.click(within(dialog).getByRole("checkbox", { name: "us" })); // off on both -> on
  await user.click(within(dialog).getByRole("button", { name: "Apply to 2 keys" }));
  await waitFor(() =>
    expect(posts(fetch)).toEqual([["/api/providers/acme/keys/bulk/update", { items: [{ key: "key_1", endpoints_add: ["us"] }, { key: "key_2", endpoints_add: ["us"] }] }]]),
  );
});

test("a bulk edit that fails on some keys names them in the bar, with Undo for the rest", async () => {
  const user = userEvent.setup();
  renderTab([key(1), key(2), key(3)], undefined, { refuse: [1] });
  await user.click(await screen.findByRole("checkbox", { name: "Select all rows on this page" }));
  const bar = screen.getByRole("group", { name: "3 selected" });
  await user.click(within(bar).getByRole("button", { name: "Edit…" }));
  const dialog = await screen.findByRole("dialog", { name: "Edit 3 keys" });
  await user.click(within(dialog).getByRole("checkbox", { name: "Enabled" })); // all on -> off
  await user.click(within(dialog).getByRole("button", { name: "Apply to 3 keys" }));
  expect(await within(bar).findByText("2 keys changed; not changed: team-2 (no longer exists)", { ignore: "script, style, [data-ui-sdk-announcer]" })).toBeTruthy();
  expect(within(bar).getByRole("button", { name: /^Undo/ })).toBeTruthy();
});

test("Delete… in the bulk menu is red and asks first, naming the count; Cancel deletes nothing", async () => {
  const user = userEvent.setup();
  const fetch = renderTab([key(1), key(2), key(3)]);
  await user.click(await screen.findByRole("checkbox", { name: "Select all rows on this page" }));
  await user.click(screen.getByRole("button", { name: "More actions for the selected keys" }));
  const del = await screen.findByRole("menuitem", { name: "Delete…" });
  expect(del.hasAttribute("data-destructive")).toBe(true);
  await user.click(del);
  const dialog = await screen.findByRole("alertdialog", { name: "Delete 3 keys?" });
  expect(dialog.textContent).toContain("team-1, team-2, team-3");
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(posts(fetch)).toHaveLength(0);

  await user.click(screen.getByRole("button", { name: "More actions for the selected keys" }));
  await user.click(await screen.findByRole("menuitem", { name: "Delete…" }));
  await user.click(await screen.findByRole("button", { name: "Delete 3 keys" }));
  await waitFor(() => expect(posts(fetch)).toEqual([["/api/providers/acme/keys/bulk/delete", { items: ["team-1", "team-2", "team-3"] }]]));
});

test("a row's menu: Test in Chat opens the chat on the key; Delete… asks, naming the key", async () => {
  const user = userEvent.setup();
  const fetch = renderTab([key(1), key(2)]);
  await user.click(await screen.findByRole("button", { name: "More for team-2" }));
  await user.click(await screen.findByRole("menuitem", { name: "Test in Chat" }));
  expect(openChat).toHaveBeenCalledWith({ kind: "upstream_key", provider: "acme", key: "team-2" });

  await user.click(screen.getByRole("button", { name: "More for team-2" }));
  await user.click(await screen.findByRole("menuitem", { name: "Delete…" }));
  await screen.findByRole("alertdialog", { name: "Delete team-2?" });
  await user.click(screen.getByRole("button", { name: "Delete key" }));
  await waitFor(() => expect(posts(fetch)).toEqual([["/api/providers/acme/keys/bulk/delete", { items: ["team-2"] }]]));
});

test("clicking a row, or its name with the keyboard, opens the key's sheet", async () => {
  const user = userEvent.setup();
  renderTab([key(1), key(2)]);
  await user.click(within((await screen.findAllByRole("row"))[2]).getByText("Active"));
  await waitFor(() => expect(decodeURIComponent(where())).toBe("?sheet=key:acme/team-2"));
  await user.click(screen.getByRole("button", { name: "Open team-1" }));
  await waitFor(() => expect(decodeURIComponent(where())).toBe("?sheet=key:acme/team-1"));
  // No key dialog any more (UI ticket 27).
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("in select mode a click on a key's row toggles it, the bulk bar follows, and no sheet opens (UI ticket 25)", async () => {
  const user = userEvent.setup();
  renderTab([key(1), key(2), key(3)]);
  await user.click(await screen.findByRole("checkbox", { name: "Select team-1" }));
  expect(screen.getByRole("group", { name: "1 selected" })).toBeTruthy();
  const team2 = rows().find((r) => within(r).queryByText("team-2"))!;
  await user.click(within(team2).getByText("Active"));
  expect(screen.getByRole("group", { name: "2 selected" })).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: "Select team-2" }).getAttribute("aria-checked")).toBe("true");
  await user.click(within(team2).getByText("Active"));
  expect(screen.getByRole("group", { name: "1 selected" })).toBeTruthy();
  expect(decodeURIComponent(where())).not.toContain("sheet=");
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("an old link to a key's dialog (?key=) opens its sheet instead", async () => {
  renderTab([key(1), key(2)], "/providers/acme/keys?sort=state&key=team-1");
  await waitFor(() => expect(decodeURIComponent(where())).toBe("?sort=state&sheet=key:acme/team-1"));
});

test("an agent sorts the keys by their cached share to find the ones getting cache hits", async () => {
  renderTab([key(1), key(2)], undefined, { cache: [{ upstream_key_id: "key_2", requests: 4, input: 2000, cache_read: 1500 }] });
  await screen.findByRole("table", { name: "Upstream Keys" });
  await waitFor(() => expect(screen.getByText("75.0%")).toBeTruthy());
  const run = await agent.act({ steps: [{ ref: "Sort by Cached, 24 h", action: "press" }] });
  expect(run.ok, run.error?.message).toBe(true);
  expect(rows().map((r) => within(r).getByText(/^team-/).textContent)).toEqual(["team-2", "team-1"]);
  expect(where()).toContain("sort=cached");
});

test("an agent filters, selects and tests keys, and needs a person to delete one", async () => {
  const fetch = renderTab([key(1), key(2), key(3, { state: { state: "invalid" } })]);
  await screen.findByRole("table", { name: "Upstream Keys" });
  const entries = agent.snapshot().filter((e) => !e.offPage && e.component !== "more");
  for (const e of entries) expect(e.label, `${e.component} ${e.ref} has no name`).toBeTruthy();
  const labels = entries.map((e) => e.label);
  for (const l of ["Search keys by name or secret", "Show keys", "Sort by Name", "Sort by State", "Sort by Cached, 24 h", "Sort by Last used", "Select team-1", "More for team-1", "Open team-1"])
    expect(labels, `${l} is missing`).toContain(l);

  const run = await agent.act({
    steps: [
      { ref: "Select team-1", action: "toggle" },
      { ref: "Select team-2", action: "toggle" },
    ],
  });
  expect(run.ok, run.error?.message).toBe(true);
  const test = await agent.act({ steps: [{ ref: "Test", action: "press" }] });
  expect(test.ok, test.error?.message).toBe(true);
  await waitFor(() => expect(posts(fetch)).toEqual([["/api/providers/acme/keys/bulk/test", { items: ["team-1", "team-2"] }]]));

  const remove = { steps: [{ ref: "More for team-3", action: "press", args: ["Delete…"] }, { ref: "Delete team-3?", action: "press", args: ["Delete key"] }] };
  expect((await agent.act(remove)).ok).toBe(false);
  expect(posts(fetch).some(([u]) => u.endsWith("/delete"))).toBe(false);
});
