import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createAgent } from "@ui-sdk/react/agent";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Toaster } from "@/ui/toast";
import type { Rule } from "./api";
import { RulesTab } from "./Rules";

const agent = createAgent();
const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

const rule = (name: string, i: number, o: Partial<Rule> = {}): Rule => ({
  name,
  enabled: true,
  source: "builtin",
  status: ["429"],
  outcome: "cooling_key",
  key_effect: "Cools for 60 s",
  request_effect: "Tries the next key",
  hits: i,
  order: i,
  ...o,
});

const RULES = [rule("mine", 0, { source: "owner", hits: 3 }), rule("rate-limited", 1, { hits: 40 }), rule("server-error", 2, { enabled: false, hits: 0 })];

function renderTab() {
  const fetch = vi.fn<typeof globalThis.fetch>(async (u, init) => {
    if (String(u).startsWith("/api/rules?") || ((init?.method ?? "GET") === "GET" && String(u).startsWith("/api/rules"))) return answer({ rules: RULES });
    return answer({ dry_run: false, audit_entry: "aud_1", changes: [], rule: RULES[0] });
  });
  vi.stubGlobal("fetch", fetch);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/providers/acme/rules"]}>
        <RulesTab handle="acme" adding={false} setAdding={() => {}} />
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  );
  return fetch;
}

const rows = () => within(screen.getByRole("table", { name: "Failure Rules" })).getAllByRole("row").slice(1);
const calls = (fetch: ReturnType<typeof renderTab>, method: string) => fetch.mock.calls.filter(([, init]) => init?.method === method).map(([u]) => String(u));

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

test("rules keep the order they run in: the first matching rule decides", async () => {
  renderTab();
  await screen.findByRole("table", { name: "Failure Rules" });
  expect(rows().map((r) => within(r).getAllByRole("cell")[0].textContent)).toEqual(["mine", "rate-limited", "server-error"]);
  // Sorting would hide which rule wins, so the headers don't sort.
  expect(screen.queryByRole("button", { name: /^Sort by/ })).toBeNull();
});

test("the search narrows the rules by name or what they match", async () => {
  const user = userEvent.setup();
  renderTab();
  await user.type(await screen.findByRole("searchbox", { name: "Search rules" }), "server");
  expect(rows()).toHaveLength(1);
  await user.clear(screen.getByRole("searchbox", { name: "Search rules" }));
  await user.type(screen.getByRole("searchbox", { name: "Search rules" }), "nothing-like-it");
  expect(await screen.findByText("No rules match")).toBeTruthy();
});

test("a rule's switch turns it off through the API, beside its menu", async () => {
  const user = userEvent.setup();
  const fetch = renderTab();
  await user.click(await screen.findByRole("switch", { name: "rate-limited on" }));
  await waitFor(() => expect(calls(fetch, "POST")).toEqual(["/api/rules/rate-limited/disable"]));
});

test("Delete… on the Owner's rule is red and asks, naming it", async () => {
  const user = userEvent.setup();
  const fetch = renderTab();
  await user.click(await screen.findByRole("button", { name: "More for mine" }));
  const item = await screen.findByRole("menuitem", { name: "Delete…" });
  expect(item.hasAttribute("data-destructive")).toBe(true);
  await user.click(item);
  await screen.findByRole("alertdialog", { name: "Delete mine?" });
  await user.click(screen.getByRole("button", { name: "Delete rule" }));
  await waitFor(() => expect(calls(fetch, "DELETE")).toEqual(["/api/rules/mine"]));
});

test("an agent opens a built-in rule to change it", async () => {
  renderTab();
  await screen.findByRole("table", { name: "Failure Rules" });
  const entries = agent.snapshot().filter((e) => !e.offPage && e.component !== "more");
  for (const e of entries) expect(e.label, `${e.component} ${e.ref} has no name`).toBeTruthy();
  const labels = entries.map((e) => e.label);
  for (const l of ["Open mine", "More for mine", "mine on", "Open rate-limited"]) expect(labels, `${l} is missing`).toContain(l);
  const run = await agent.act({ steps: [{ ref: "Open rate-limited", action: "press" }] });
  expect(run.ok, run.error?.message).toBe(true);
  expect(await screen.findByRole("dialog")).toBeTruthy();
});
