import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createAgent } from "@ui-sdk/react/agent";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Pool, Provider } from "./api";
import { ProvidersList } from "./List";
import { SAMPLE_POOL, SAMPLE_PROVIDER } from "./samples";

const agent = createAgent();
const { openChat } = vi.hoisted(() => ({ openChat: vi.fn() }));
vi.mock("@/app/chat-panel", () => ({ useChatActions: () => ({ open: openChat, close() {}, toggle() {} }) }));
vi.mock("@/app/PageHeader", () => ({ PageHeader: ({ title, actions }: { title: string; actions?: React.ReactNode }) => <header><h1>{title}</h1>{actions}</header> }));

const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

const prov = (handle: string, o: Partial<Provider> = {}): Provider => ({ ...SAMPLE_PROVIDER, id: `prv_${handle}`, handle, name: handle, ...o });
const PROVIDERS = [prov("zeta"), prov("acme"), prov("old", { archived: true }), prov("busy")];
const POOLS: Pool[] = [{ ...SAMPLE_POOL, id: "pool_fast", name: "fast", members: [{ position: 1, provider: "acme", model: "m", enabled: true }] }];

const traffic = (requests: number) => ({ requests, succeeded: requests, failed: 0 });
const OVERVIEW = {
  since: "2026-11-19T00:00:00Z",
  providers: [
    { provider: "busy", keys: { total: 3, active: 3, disabled: 0, invalid: 0, cooling: 0, keyless: 0 }, models: 4, ...traffic(90) },
    { provider: "acme", keys: { total: 9, active: 2, disabled: 0, invalid: 0, cooling: 0, keyless: 0 }, models: 12, ...traffic(5) },
    { provider: "old", keys: { total: 1, active: 0, disabled: 0, invalid: 0, cooling: 0, keyless: 0 }, models: 0, ...traffic(500) },
  ],
  pools: [{ pool: "fast", served_by: [], ...traffic(7) }],
};

function Where() {
  const l = useLocation();
  return <output aria-label="Where">{l.pathname + l.search}</output>;
}

function renderList(url = "/providers") {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof globalThis.fetch>(async (u) => {
      const path = String(u);
      if (path.startsWith("/api/providers")) return answer({ providers: PROVIDERS });
      if (path.startsWith("/api/pools")) return answer({ pools: POOLS });
      if (path.startsWith("/api/overview")) return answer(OVERVIEW);
      return new Response("{}", { status: 404 });
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/providers" element={<ProvidersList />} />
          <Route path="*" element={null} />
        </Routes>
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const rows = (label: string) => within(screen.getByRole("table", { name: label })).getAllByRole("row").slice(1);
const firstCells = (label: string) => rows(label).map((r) => within(r).getAllByRole("cell")[0].textContent);
const where = () => screen.getByLabelText("Where").textContent ?? "";

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  openChat.mockClear();
});

test("Providers come busiest first with archived ones last, and sort by a column", async () => {
  const user = userEvent.setup();
  renderList();
  await screen.findByRole("table", { name: "Providers" });
  expect(firstCells("Providers")).toEqual(["busy", "acme", "zeta", "old"].map((h) => expect.stringContaining(h)));
  await user.click(screen.getByRole("button", { name: "Sort by Name" }));
  expect(firstCells("Providers")).toEqual(["acme", "busy", "old", "zeta"].map((h) => expect.stringContaining(h)));
  // Fewest first; a Provider the overview doesn't name ("–") counts as fewer than none.
  await user.click(screen.getByRole("button", { name: "Sort by Active keys" }));
  expect(firstCells("Providers")).toEqual(["zeta", "old", "acme", "busy"].map((h) => expect.stringContaining(h)));
  expect(screen.getByText("4 Providers")).toBeTruthy();
});

test("the search narrows the Providers and lives in the URL", async () => {
  const user = userEvent.setup();
  renderList();
  await user.type(await screen.findByRole("searchbox", { name: "Search Providers" }), "ac");
  expect(rows("Providers")).toHaveLength(1);
  expect(where()).toContain("q=ac");
});

test("clicking a Provider row opens its page; Test in Chat doesn't", async () => {
  const user = userEvent.setup();
  renderList();
  await screen.findByRole("table", { name: "Providers" });
  await user.click(screen.getByRole("button", { name: "Test acme in Chat" }));
  expect(openChat).toHaveBeenCalledExactlyOnceWith({ kind: "provider", provider: "acme" });
  expect(where()).toBe("/providers");
  await user.click(within(rows("Providers")[1]).getAllByRole("cell")[2]);
  expect(where()).toBe("/providers/acme/keys");
});

test("Model Pools sit in their own table: a row opens the Pool, Test in Chat tests it", async () => {
  const user = userEvent.setup();
  renderList();
  await screen.findByRole("table", { name: "Model Pools" });
  expect(firstCells("Model Pools")).toEqual([expect.stringContaining("fast")]);
  await user.click(screen.getByRole("button", { name: "Test fast in Chat" }));
  expect(openChat).toHaveBeenCalledExactlyOnceWith({ kind: "pool", pool: "fast" });
  await user.click(within(rows("Model Pools")[0]).getAllByRole("cell")[2]);
  expect(where()).toBe("/providers/pools/fast/route");
});

test("an agent finds the tables' controls by name and tests a Provider", async () => {
  renderList();
  await screen.findByRole("table", { name: "Model Pools" });
  const entries = agent.snapshot().filter((e) => !e.offPage && e.component !== "more");
  for (const e of entries) expect(e.label, `${e.component} ${e.ref} has no name`).toBeTruthy();
  const labels = entries.map((e) => e.label);
  for (const l of ["Search Providers", "Sort by Name", "Sort by Requests today", "Sort by Pool name", "Open busy", "Open fast", "Test busy in Chat", "Test fast in Chat"])
    expect(labels, `${l} is missing`).toContain(l);
  // The two tables' controls never share a name.
  const sorts = labels.filter((l) => l?.startsWith("Sort by"));
  expect(new Set(sorts).size).toBe(sorts.length);
  const run = await agent.act({ steps: [{ ref: "Test busy in Chat", action: "press" }] });
  expect(run.ok, run.error?.message).toBe(true);
  expect(openChat).toHaveBeenCalledExactlyOnceWith({ kind: "provider", provider: "busy" });
});
