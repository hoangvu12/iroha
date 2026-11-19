import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createAgent } from "@ui-sdk/react/agent";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Toaster } from "@/ui/toast";
import type { UpstreamKey } from "./api";
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

function renderTab(keys: UpstreamKey[], url = "/providers/acme/keys") {
  const fetch = vi.fn<typeof globalThis.fetch>(async (u, init) => {
    const path = String(u);
    if (path.startsWith("/api/providers/acme/keys") && (init?.method ?? "GET") === "GET") return answer({ upstream_keys: keys });
    const items: string[] = JSON.parse(String(init?.body ?? "{}")).items ?? [];
    return answer({ dry_run: false, audit_entry: "aud_1", succeeded: items.length, failed: 0, items: items.map((_, index) => ({ index, ok: true, outcome: "updated", changes: [] })) });
  });
  vi.stubGlobal("fetch", fetch);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <KeysTab handle="acme" adding={false} setAdding={() => {}} />
        <Where />
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

test("clicking a row, or its name with the keyboard, opens the key", async () => {
  const user = userEvent.setup();
  renderTab([key(1), key(2)]);
  await user.click(within((await screen.findAllByRole("row"))[2]).getByText("Active"));
  expect(where()).toContain("key=team-2");
  expect(await screen.findByRole("dialog", { name: "team-2" })).toBeTruthy();
});

test("an agent filters, selects and tests keys, and needs a person to delete one", async () => {
  const fetch = renderTab([key(1), key(2), key(3, { state: { state: "invalid" } })]);
  await screen.findByRole("table", { name: "Upstream Keys" });
  const entries = agent.snapshot().filter((e) => !e.offPage && e.component !== "more");
  for (const e of entries) expect(e.label, `${e.component} ${e.ref} has no name`).toBeTruthy();
  const labels = entries.map((e) => e.label);
  for (const l of ["Search keys by name or secret", "Show keys", "Sort by Name", "Sort by State", "Sort by Last used", "Select team-1", "More for team-1", "Open team-1"])
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

// Motion (UI ticket 17): the key dialog stays mounted while it leaves, so the
// dialog recipe's exit plays (it used to vanish), showing the key it was about.
test("closing a key's dialog plays its exit, still showing that key, then it goes", async () => {
  let end = () => {};
  const finished = new Promise<void>((r) => (end = r));
  const running = { finished, effect: { getComputedTiming: () => ({ endTime: 60_000, localTime: 0 }) } } as unknown as Animation;
  const before = Element.prototype.getAnimations;
  try {
    const user = userEvent.setup();
    renderTab([key(1), key(2)], "/providers/acme/keys?key=team-1");
    const dialog = await screen.findByRole("dialog", { name: "team-1" });
    // From here on the dialog's exit runs until the test ends it (jsdom has no transitions).
    Element.prototype.getAnimations = function (this: Element) {
      return this === dialog ? [running] : [];
    };
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(where()).not.toContain("key="));
    expect(dialog.isConnected).toBe(true);
    expect(dialog.hasAttribute("data-ending-style")).toBe(true);
    expect(within(dialog).getByRole("heading", { name: "team-1" })).toBeTruthy();
    await act(async () => end());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  } finally {
    Element.prototype.getAnimations = before;
  }
});
