import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgent } from "@ui-sdk/react/agent";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Toaster } from "@/ui/toast";
import type { MemberInput, Pool } from "./api";
import { PoolMembersTab } from "./PoolMembers";

const agent = createAgent();
const { openChat } = vi.hoisted(() => ({ openChat: vi.fn() }));
vi.mock("@/app/chat-panel", () => ({ useChatActions: () => ({ open: openChat, close() {}, toggle() {} }) }));

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

const pool: Pool = {
  id: "pool_1",
  name: "fast",
  maker: "",
  maker_guessed: true,
  members: [
    { position: 1, provider: "acme", model: "m-1", enabled: true },
    { position: 2, provider: "zeta", model: "qwen/m-2", enabled: true },
    { position: 3, provider: "kappa", model: "m-3", enabled: true },
  ],
  budget: { max_attempts: 3, first_byte_seconds: 30 },
  created_at: "2026-11-19T00:00:00Z",
};

let fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
beforeEach(() => {
  localStorage.clear();
  fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const u = new URL(String(url), "http://iroha.test");
    if (u.pathname === "/api/overview") return json({ since: "2026-11-19T00:00:00Z", providers: [], pools: [] });
    if (u.pathname === "/api/gateway-keys") return json({ gateway_keys: [] });
    if (u.pathname === "/api/pools/fast" && init?.method === "PATCH") return json({ dry_run: false, audit_entry: "aud_1", changes: [], pool });
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  openChat.mockClear();
});

/** Renders the tab and waits for the members, shown once the overview has loaded too (UI ticket 02). */
async function renderTab() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <PoolMembersTab name="fast" pool={pool} onAdd={() => {}} />
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  );
  await screen.findByRole("button", { name: "More for acme (m-1)" });
}

const saved = () =>
  fetch.mock.calls.filter(([, init]) => init?.method === "PATCH").map(([, init]) => (JSON.parse(String(init?.body)).members as MemberInput[]).map((m) => `${m.provider}${m.enabled ? "" : " off"}`));
const order = () =>
  within(screen.getByRole("table", { name: "Members of fast" }))
    .getAllByRole("row")
    .slice(1)
    // Cells: select box (UI ticket 30), order, handle, Provider.
    .map((r) => within(r).getAllByRole("cell")[3].textContent);

test("members sit in their order, numbered; the headers don't sort, since the order is what counts", async () => {
  await renderTab();
  expect(order()).toEqual(["acme", "zeta", "kappa"]);
  expect(screen.queryByRole("button", { name: /^Sort by/ })).toBeNull();
});

test("a member's handle reorders with the keyboard: Space picks it up, arrows move it, Space drops it and saves", async () => {
  const user = userEvent.setup();
  await renderTab();
  screen.getByRole("button", { name: "Reorder acme (m-1)" }).focus();
  await user.keyboard(" ");
  await user.keyboard("{ArrowDown}");
  expect(order()).toEqual(["zeta", "acme", "kappa"]);
  expect(saved()).toEqual([]); // nothing saved while it is held
  await user.keyboard(" ");
  await waitFor(() => expect(saved()).toEqual([["zeta", "acme", "kappa"]]));
  expect(await screen.findByText("acme moved to position 2", { ignore: "script, style, [data-ui-sdk-announcer]" })).toBeTruthy();
});

test("Escape puts a picked-up member back and saves nothing", async () => {
  const user = userEvent.setup();
  await renderTab();
  screen.getByRole("button", { name: "Reorder kappa (m-3)" }).focus();
  await user.keyboard(" {ArrowUp}{ArrowUp}");
  expect(order()).toEqual(["kappa", "acme", "zeta"]);
  await user.keyboard("{Escape}");
  expect(order()).toEqual(["acme", "zeta", "kappa"]);
  expect(saved()).toEqual([]);
});

test("Move down in a member's menu moves it at once; its switch turns it off", async () => {
  const user = userEvent.setup();
  await renderTab();
  await user.click(screen.getByRole("button", { name: "More for acme (m-1)" }));
  await user.click(await screen.findByRole("menuitem", { name: "Move down" }));
  await waitFor(() => expect(saved()).toEqual([["zeta", "acme", "kappa"]]));
  await user.click(screen.getByRole("switch", { name: "kappa on" }));
  await waitFor(() => expect(saved().at(-1)).toEqual(["zeta", "acme", "kappa off"]));
});

test("Remove… is red and asks, naming the member; confirming saves the Pool without it", async () => {
  const user = userEvent.setup();
  await renderTab();
  await user.click(screen.getByRole("button", { name: "More for zeta (qwen/m-2)" }));
  const item = await screen.findByRole("menuitem", { name: "Remove…" });
  expect(item.hasAttribute("data-destructive")).toBe(true);
  await user.click(item);
  await screen.findByRole("alertdialog", { name: "Remove zeta (qwen/m-2) from fast?" });
  expect(saved()).toEqual([]);
  await user.click(screen.getByRole("button", { name: "Remove member" }));
  await waitFor(() => expect(saved()).toEqual([["acme", "kappa"]]));
});

test("Edit… switches the selected members off in one save, the others kept; the result and Undo show in the bar", async () => {
  const user = userEvent.setup();
  await renderTab();
  await user.click(screen.getByRole("checkbox", { name: "Select acme (m-1)" }));
  await user.click(screen.getByRole("checkbox", { name: "Select kappa (m-3)" }));
  const bar = screen.getByRole("group", { name: "2 selected" });
  await user.click(within(bar).getByRole("button", { name: "Edit…" }));
  const dialog = await screen.findByRole("dialog", { name: "Edit 2 members" });
  await user.click(within(dialog).getByRole("checkbox", { name: "On" }));
  await user.click(within(dialog).getByRole("button", { name: "Apply to 2 members" }));
  await waitFor(() => expect(saved()).toEqual([["acme off", "zeta", "kappa off"]]));
  expect(await within(bar).findByText("2 members switched off", { ignore: "script, style, [data-ui-sdk-announcer]" })).toBeTruthy();
  expect(within(bar).getByRole("button", { name: "Undo: 2 members switched off" })).toBeTruthy();
});

test("Test in Chat on a member opens the chat on its Provider and model", async () => {
  const user = userEvent.setup();
  await renderTab();
  await user.click(screen.getByRole("button", { name: "More for zeta (qwen/m-2)" }));
  await user.click(await screen.findByRole("menuitem", { name: "Test in Chat" }));
  expect(openChat).toHaveBeenCalledExactlyOnceWith({ kind: "model", provider: "zeta", model: "qwen/m-2" });
});

test("an agent finds the members' controls, tests one, and moves one to the top", async () => {
  await renderTab();
  const entries = agent.snapshot().filter((e) => !e.offPage && e.component !== "more");
  for (const e of entries) expect(e.label, `${e.component} ${e.ref} has no name`).toBeTruthy();
  const labels = entries.map((e) => e.label);
  // The handles are parts of "Order of fast's members": an agent moves a member with its `move`.
  for (const l of ["Order of fast's members", "More for acme (m-1)", "acme on"]) expect(labels, `${l} is missing`).toContain(l);
  expect(agent.snapshot().find((e) => e.label === "Order of fast's members")?.actions).toContain("move");

  const run = await agent.act({ steps: [{ ref: "More for acme (m-1)", action: "press", args: ["Test in Chat"] }] });
  expect(run.ok, run.error?.message).toBe(true);
  expect(openChat).toHaveBeenCalledExactlyOnceWith({ kind: "model", provider: "acme", model: "m-1" });

  const move = await agent.act({ steps: [{ ref: "Order of fast's members", action: "move", args: ["kappa/m-3", 0] }] });
  expect(move.ok, move.error?.message).toBe(true);
  await waitFor(() => expect(saved()).toEqual([["kappa", "acme", "zeta"]]));
  expect(order()).toEqual(["kappa", "acme", "zeta"]);
});
