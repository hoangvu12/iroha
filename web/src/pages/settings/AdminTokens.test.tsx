import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createAgent } from "@ui-sdk/react/agent";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Toaster } from "@/ui/toast";
import { AdminTokensTab } from "./AdminTokens";
import type { AdminToken } from "./api";

// Settings → Admin Tokens on the shared DataTable (UI ticket 08): sorting,
// pages, and Revoke… asking for the name typed.

let approve = false;
const agent = createAgent({ allow: (step) => !step.confirm || approve });
const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

const token = (i: number, o: Partial<AdminToken> = {}): AdminToken => ({
  id: `at_${i}`,
  name: `script-${i}`,
  note: "",
  secret: `iroha_admin_secret${String(i).padStart(4, "0")}`,
  revoked: false,
  created_at: new Date(Date.UTC(2026, 10, i)).toISOString(),
  last_used_at: new Date(Date.now() - i * 60_000).toISOString(),
  ...o,
});

function renderTab(tokens: AdminToken[]) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (u, init) => {
    if (String(u).startsWith("/api/admin-tokens") && (init?.method ?? "GET") === "GET") return answer({ admin_tokens: tokens });
    return answer({ audit_entry: "ae_1", changes: [], admin_token: tokens[0] });
  });
  vi.stubGlobal("fetch", fetch);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <AdminTokensTab />
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  );
  return fetch;
}

const writes = (fetch: ReturnType<typeof renderTab>) =>
  fetch.mock.calls.filter(([, init]) => (init?.method ?? "GET") !== "GET").map(([u, init]) => `${init?.method} ${String(u)}`);
const rows = () => within(screen.getByRole("table", { name: "Admin Tokens" })).getAllByRole("row").slice(1);

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  approve = false;
});

test("tokens come oldest first in numbered pages past 25, and sort by Created and by Last used", async () => {
  const user = userEvent.setup();
  renderTab(Array.from({ length: 30 }, (_, i) => token(i + 1)));
  await screen.findByRole("table", { name: "Admin Tokens" });
  expect(rows()).toHaveLength(25);
  expect(within(rows()[1]).getByText("script-2")).toBeTruthy();
  expect(screen.getByRole("columnheader", { name: /Created/ }).getAttribute("aria-sort")).toBe("ascending");
  await user.click(screen.getByRole("button", { name: "Sort by Created" }));
  expect(within(rows()[0]).getByText("script-30")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Sort by Last used" }));
  expect(within(rows()[0]).getByText("script-1")).toBeTruthy(); // the most recent use first
  expect(screen.getByRole("navigation", { name: "Pages of Admin Tokens" })).toBeTruthy();
});

test("Revoke… in a token's menu is red and asks for its name typed before it revokes", async () => {
  const user = userEvent.setup();
  const fetch = renderTab([token(1), token(2)]);
  await user.click(await screen.findByRole("button", { name: "More for script-2" }));
  const revoke = await screen.findByRole("menuitem", { name: "Revoke…" });
  expect(revoke.hasAttribute("data-destructive")).toBe(true);
  await user.click(revoke);
  const dialog = await screen.findByRole("alertdialog", { name: "Revoke script-2?" });
  await user.type(within(dialog).getByRole("textbox"), "script-2");
  await user.click(within(dialog).getByRole("button", { name: "Revoke token" }));
  await waitFor(() => expect(writes(fetch)).toEqual(["POST /api/admin-tokens/at_2/revoke"]));
});

test("no tokens: the empty state", async () => {
  renderTab([]);
  expect(await screen.findByText("No Admin Tokens")).toBeTruthy();
  expect(screen.queryByRole("table")).toBeNull();
});

test("the new token, shown once, rises into place in the dialog with its title and text (UI ticket 20)", async () => {
  const user = userEvent.setup();
  renderTab([token(1)]);
  await user.click(await screen.findByRole("button", { name: "New Admin Token" }));
  await user.type(await screen.findByRole("textbox", { name: "Name" }), "deploy-script");
  await user.click(screen.getByRole("button", { name: "Create token" }));
  const dialog = await screen.findByRole("dialog", { name: "Admin Token created" });
  const rising = [within(dialog).getByText(token(1).secret), within(dialog).getByText("Admin Token created"), within(dialog).getByText(/Give it to/)];
  for (const el of rising) {
    const c = el.closest(".starting\\:opacity-0")!.getAttribute("class")!.split(/\s+/);
    for (const k of ["transition-[opacity,translate]", "duration-list-in", "ease-out", "starting:translate-y-(--motion-shift-sm)"]) expect(c).toContain(k);
  }
});

test("a row's copy button, shown on hover, is always shown where nothing hovers (touch)", async () => {
  renderTab([token(1)]);
  const copy = await screen.findByRole("button", { name: "Copy script-1" });
  const c = copy.getAttribute("class")!.split(/\s+/);
  // row-reveal (styles/index.css): hidden until the row is hovered, always shown where nothing hovers.
  expect(c).toContain("row-reveal");
});

test("an agent sorts the tokens and opens a menu, and needs a person to revoke one", async () => {
  const fetch = renderTab([token(1, { name: "zeron-agent" }), token(2, { name: "backup-cron" })]);
  await screen.findByRole("table", { name: "Admin Tokens" });
  const entries = agent.snapshot().filter((e) => !e.offPage && e.component !== "more");
  for (const e of entries) expect(e.label, `${e.component} ${e.ref} has no name`).toBeTruthy();
  const labels = entries.map((e) => e.label);
  for (const l of ["New Admin Token", "Sort by Name", "Sort by Created", "Sort by Last used", "More for zeron-agent", "Copy zeron-agent"]) expect(labels, `${l} is missing`).toContain(l);
  expect(within(rows()[0]).getByText("zeron-agent")).toBeTruthy();
  const run = await agent.act({ steps: [{ ref: "Sort by Name", action: "press" }] });
  expect(run.ok, run.error?.message).toBe(true);
  expect(within(rows()[0]).getByText("backup-cron")).toBeTruthy();
  const revoke = { steps: [{ ref: "More for zeron-agent", action: "press", args: ["Revoke…"] }, { ref: "Revoke zeron-agent?", action: "press", args: ["Revoke token"] }] };
  expect((await agent.act(revoke)).ok).toBe(false);
  expect(writes(fetch)).toEqual([]);
});
