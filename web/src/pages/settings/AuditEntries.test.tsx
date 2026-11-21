import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createAgent } from "@ui-sdk/react/agent";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AuditEntry } from "@/api/types";
import { Toaster } from "@/ui/toast";
import { AuditEntriesTab } from "./AuditEntries";

let approve = false;
const agent = createAgent({ allow: (step) => !step.confirm || approve });
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const onPage = { ignore: "script, style, [data-ui-sdk-announcer]" };

const BASE = Date.now();

const entry = (i: number, o: Partial<AuditEntry> = {}): AuditEntry => ({
  id: `ae_${i}`,
  time: new Date(BASE - i * 60_000).toISOString(),
  actor: { kind: "owner_session", id: "os_1", name: "Owner" },
  action: "update",
  summary: `Upstream Key acme/team-${i} disabled`,
  revertible: true,
  changes: [{ resource: "upstream_key", id: `key_${i}`, name: `acme/team-${i}`, op: "update", fields: ["enabled"], before: { enabled: true }, after: { enabled: false } }],
  ...o,
});

const FILTERS = {
  actors: [{ kind: "owner_session", name: "Owner", filter: "owner", entries: 3, last_at: "2026-11-19T09:00:00Z" }],
  resources: [
    { name: "upstream_key", label: "Upstream Key", plural: "Upstream Keys", entries: 2 },
    { name: "admin_token", label: "Admin Token", plural: "Admin Tokens", entries: 1 },
  ],
};

function Where() {
  const l = useLocation();
  return <output aria-label="Where">{l.search}</output>;
}

function renderTab(all: AuditEntry[], url = "/settings/audit-entries") {
  const fetch = vi.fn<typeof globalThis.fetch>(async (u, init) => {
    const at = new URL(String(u), "http://iroha");
    if (init?.method === "POST") return answer({ audit_entry: "ae_new", changes: [], reverted: "x" });
    if (at.pathname === "/api/audit-entries/filters") return answer(FILTERS);
    const q = at.searchParams;
    const matched = all.filter((e) => !q.get("resource") || e.changes.some((c) => c.resource === q.get("resource")));
    const from = q.get("before") ? matched.findIndex((e) => e.id === q.get("before")) + 1 : 0;
    const limit = Number(q.get("limit"));
    const page = matched.slice(from, from + limit);
    return answer({ entries: page, next_before: from + limit < matched.length ? page[page.length - 1].id : undefined });
  });
  vi.stubGlobal("fetch", fetch);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <AuditEntriesTab />
        <Where />
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  );
  return fetch;
}

const lists = (fetch: ReturnType<typeof renderTab>) =>
  fetch.mock.calls.map(([u]) => new URL(String(u), "http://iroha")).filter((u) => u.pathname === "/api/audit-entries").map((u) => u.search);
const posts = (fetch: ReturnType<typeof renderTab>) => fetch.mock.calls.filter(([, i]) => i?.method === "POST").map(([u]) => String(u));
const rows = () =>
  within(screen.getByRole("table", { name: "Audit Entries" }))
    .getAllByRole("row")
    .slice(1);
const where = () => screen.getByLabelText("Where").textContent ?? "";
const many = (n: number) => Array.from({ length: n }, (_, i) => entry(i + 1));

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  approve = false;
});

test("numbered pages read the next page from the API's cursor, a page at a time", async () => {
  const user = userEvent.setup();
  const fetch = renderTab(many(60));
  await screen.findByText("Upstream Key acme/team-1 disabled");
  expect(rows()).toHaveLength(25);
  expect(lists(fetch)).toEqual(["?limit=25"]);
  expect(screen.getByText(/1–25 of more than 25 changes/)).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "Page 2" }));
  expect(await screen.findByText("Upstream Key acme/team-26 disabled")).toBeTruthy();
  expect(lists(fetch)).toEqual(["?limit=25", "?before=ae_25&limit=25"]);
  expect(rows()).toHaveLength(25);

  await user.click(screen.getByRole("button", { name: "Page 3" }));
  expect(await screen.findByText("Upstream Key acme/team-51 disabled")).toBeTruthy();
  await waitFor(() => expect(rows()).toHaveLength(10));
  expect(screen.getByText(/51–60 of 60 changes/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Page 4" })).toBeNull();

  await user.click(screen.getByRole("button", { name: "Page 1" }));
  expect(within(rows()[0]).getByText("Upstream Key acme/team-1 disabled")).toBeTruthy();
  expect(lists(fetch)).toHaveLength(3);
});

test("the page size is the API's page size, and is remembered", async () => {
  const user = userEvent.setup();
  const fetch = renderTab(many(60));
  await screen.findByText("Upstream Key acme/team-1 disabled");
  await user.click(screen.getByRole("combobox", { name: "Rows per page" }));
  await user.click(await screen.findByRole("option", { name: "50 per page" }));
  await waitFor(() => expect(rows()).toHaveLength(50));
  expect(lists(fetch)).toContain("?limit=50");
  expect(localStorage.getItem("iroha:table:audit-entries:page-size")).toBe("50");
});

test("the filters stay in the URL: a link with ?resource= opens filtered, and the menu changes it back to page 1", async () => {
  const user = userEvent.setup();
  const all = [...many(30), entry(99, { summary: "Created Admin Token huy", changes: [{ resource: "admin_token", id: "at_1", name: "huy", op: "update", fields: ["note"], before: {}, after: {} }] })];
  const fetch = renderTab(all, "/settings/audit-entries?resource=admin_token");
  expect(await screen.findByText("Created Admin Token")).toBeTruthy();
  expect(lists(fetch)[0]).toContain("resource=admin_token");
  expect(rows()).toHaveLength(1);
  expect(screen.getAllByText("Only Admin Tokens").length).toBeGreaterThan(0);

  await user.click(screen.getByRole("button", { name: "Anyone" }));
  await user.click(await screen.findByRole("menuitemradio", { name: "Everything" }));
  await waitFor(() => expect(rows()).toHaveLength(25), { timeout: 4000 });
  expect(where()).not.toContain("resource");

  await user.type(screen.getByRole("searchbox", { name: "Search changes" }), "team-3");
  await waitFor(() => expect(where()).toContain("q=team-3"), { timeout: 4000 });
  await waitFor(() => expect(lists(fetch).at(-1)).toContain("q=team-3"), { timeout: 4000 });
}, 20_000);

test("filters that match nothing show the chips with Clear filters", async () => {
  const user = userEvent.setup();
  renderTab(many(3), "/settings/audit-entries?resource=pool");
  expect(await screen.findByText("No changes match these filters")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Clear filters" }));
  await waitFor(() => expect(rows()).toHaveLength(3));
  expect(where()).toBe("");
});

test("a row click, or its chevron, shows the before and after under the row", async () => {
  const user = userEvent.setup();
  renderTab(many(3));
  const show = await screen.findByRole("button", { name: /^Show details of Upstream Key acme\/team-2 disabled/ });
  expect(show.getAttribute("aria-expanded")).toBe("false");
  await user.click(within(rows()[1]).getByText("Upstream Key acme/team-2 disabled"));
  expect(screen.getByRole("button", { name: /^Hide details of Upstream Key acme\/team-2 disabled/ }).getAttribute("aria-expanded")).toBe("true");
  expect(rows()).toHaveLength(4);
  expect(rows()[2].textContent).toMatch(/enabled/i);
});

test("opened details enter like a row (UI ticket 20): a row's shift and a fade, never their height", async () => {
  const user = userEvent.setup();
  renderTab(many(3));
  await user.click(await screen.findByRole("button", { name: /^Show details of Upstream Key acme\/team-2 disabled/ }));
  const details = rows()[2].querySelector("td > *")!;
  const c = details.getAttribute("class")!.split(/\s+/);
  for (const k of ["transition-[opacity,translate]", "duration-list-in", "ease-out", "starting:translate-y-(--motion-shift-sm)", "starting:opacity-0"]) expect(c).toContain(k);
  expect(c.filter((x) => /transition-\[height|duration-\d/.test(x))).toEqual([]);
});

test("Revert in a row reverts it and shows the result, with Undo, in its place", async () => {
  const user = userEvent.setup();
  const fetch = renderTab(many(3));
  await user.click(await screen.findByRole("button", { name: "Revert Upstream Key acme/team-2 disabled" }));
  await waitFor(() => expect(posts(fetch)).toEqual(["/api/audit-entries/ae_2/revert"]));
  expect(await within(rows()[1]).findByText("Reverted", onPage)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Show details/, expanded: true })).toBeNull();
});

test("reverting a create asks first, naming what goes", async () => {
  const user = userEvent.setup();
  const made = entry(5, { summary: "Created Admin Token huy", action: "create", changes: [{ resource: "admin_token", id: "at_1", name: "huy", op: "create", before: null, after: {} }] });
  const fetch = renderTab([made]);
  const revert = await screen.findByRole("button", { name: "Revert Created Admin Token huy…" });
  expect(revert.hasAttribute("data-danger")).toBe(true);
  await user.click(revert);
  await user.click(within(await screen.findByRole("alertdialog", { name: "Revert and delete huy?" })).getByRole("button", { name: "Revert and delete" }));
  await waitFor(() => expect(posts(fetch)).toEqual(["/api/audit-entries/ae_5/revert"]));
});

test("an agent searches, filters by resource, opens an entry and reverts it", async () => {
  const fetch = renderTab(many(3));
  await screen.findByRole("table", { name: "Audit Entries" });
  const entries = agent.snapshot().filter((e) => !e.offPage && e.component !== "more");
  for (const e of entries) expect(e.label, `${e.component} ${e.ref} has no name`).toBeTruthy();
  const labels = entries.map((e) => e.label);
  for (const l of ["Search changes", "Anyone", "Show details of Upstream Key acme/team-1 disabled at " + clock(1), "Revert Upstream Key acme/team-1 disabled"])
    expect(labels, `${l} is missing`).toContain(l);

  const open = await agent.act({ steps: [{ ref: "Show details of Upstream Key acme/team-1 disabled at " + clock(1), action: "press" }] });
  expect(open.ok, open.error?.message).toBe(true);
  expect(rows()).toHaveLength(4);
  const revert = await agent.act({ steps: [{ ref: "Revert Upstream Key acme/team-3 disabled", action: "press" }] });
  expect(revert.ok, revert.error?.message).toBe(true);
  await waitFor(() => expect(posts(fetch)).toEqual(["/api/audit-entries/ae_3/revert"]));
});

function clock(i: number) {
  return new Date(BASE - i * 60_000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
}
