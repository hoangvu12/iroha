import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createAgent } from "@ui-sdk/react/agent";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SheetStackProvider } from "@/sheets/stack";
import { Toaster } from "@/ui/toast";
import type { Endpoint, Provider } from "./api";
import { EndpointsTab } from "./Endpoints";
import { SAMPLE_PROVIDER } from "./samples";

const agent = createAgent();
const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

const ep = (name: string, url: string, o: Partial<Endpoint> = {}): Endpoint => ({
  id: `ep_${name}`,
  provider: "acme",
  name,
  url,
  shape: "openai-chat",
  auth_style: "bearer",
  static_headers: {},
  renames: {},
  discovery_url: "",
  created_at: "2026-11-19T00:00:00Z",
  ...o,
});

const provider: Provider = {
  ...SAMPLE_PROVIDER,
  handle: "acme",
  endpoints: [ep("intl", "https://intl.acme.test/v1"), ep("cn", "https://cn.acme.test/v1", { shape: "anthropic-messages" })],
};

function Where() {
  const l = useLocation();
  return <output aria-label="Where">{decodeURIComponent(l.search)}</output>;
}
const where = () => screen.getByLabelText("Where").textContent;

function renderTab() {
  const fetch = vi.fn<typeof globalThis.fetch>(async (u) => {
    if (String(u).startsWith("/api/providers/acme/keys")) return answer({ upstream_keys: [] });
    return answer({ dry_run: false, audit_entry: "aud_1", changes: [], endpoint: provider.endpoints[0] });
  });
  vi.stubGlobal("fetch", fetch);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/providers/acme/endpoints"]}>
        <SheetStackProvider>
          <EndpointsTab handle="acme" provider={provider} adding={false} setAdding={() => {}} />
          <Where />
        </SheetStackProvider>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  );
  return fetch;
}

const rows = () => within(screen.getByRole("table", { name: "Endpoints" })).getAllByRole("row").slice(1);
const deletes = (fetch: ReturnType<typeof renderTab>) => fetch.mock.calls.filter(([, init]) => init?.method === "DELETE").map(([u]) => String(u));

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

test("endpoints sit in the shared table, sortable by name", async () => {
  const user = userEvent.setup();
  renderTab();
  await screen.findByRole("table", { name: "Endpoints" });
  expect(within(rows()[0]).getByText("intl")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Sort by Name" }));
  expect(within(rows()[0]).getByText("cn")).toBeTruthy();
  expect(screen.getByText("2 Endpoints")).toBeTruthy();
});

test("clicking a row, or its name, opens the Endpoint's sheet (UI ticket 27: it was an edit dialog)", async () => {
  const user = userEvent.setup();
  renderTab();
  await user.click(await screen.findByRole("button", { name: "Open cn" }));
  await waitFor(() => expect(where()).toBe("?sheet=endpoint:acme/cn"));
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("Delete… in a row's menu is red and asks, naming the Endpoint; confirming deletes it", async () => {
  const user = userEvent.setup();
  const fetch = renderTab();
  await user.click(await screen.findByRole("button", { name: "More for cn" }));
  const item = await screen.findByRole("menuitem", { name: "Delete…" });
  expect(item.hasAttribute("data-destructive")).toBe(true);
  await user.click(item);
  await screen.findByRole("alertdialog", { name: "Delete cn?" });
  expect(deletes(fetch)).toHaveLength(0);
  await user.click(screen.getByRole("button", { name: "Delete endpoint" }));
  await waitFor(() => expect(deletes(fetch)).toEqual(["/api/providers/acme/endpoints/cn"]));
  // The menu's click never opened the row's sheet under it.
  expect(where()).toBe("");
});

// The fields' own tests (the header name folding open) are in sheets/EndpointSheet.test.tsx: an Endpoint is edited in its sheet.

test("an agent finds every endpoint control by name and opens one", async () => {
  renderTab();
  await screen.findByRole("table", { name: "Endpoints" });
  const entries = agent.snapshot().filter((e) => !e.offPage && e.component !== "more");
  for (const e of entries) expect(e.label, `${e.component} ${e.ref} has no name`).toBeTruthy();
  const labels = entries.map((e) => e.label);
  for (const l of ["Sort by Name", "Open intl", "More for intl", "Open cn", "More for cn"]) expect(labels, `${l} is missing`).toContain(l);
  const run = await agent.act({ steps: [{ ref: "Open intl", action: "press" }] });
  expect(run.ok, run.error?.message).toBe(true);
  await waitFor(() => expect(where()).toBe("?sheet=endpoint:acme/intl"));
});
