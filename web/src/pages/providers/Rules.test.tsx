import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createAgent } from "@ui-sdk/react/agent";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Toaster } from "@/ui/toast";
import type { Rule } from "./api";
import { RulesTab } from "./Rules";
import { SheetStackProvider } from "@/sheets/stack";

function Where() {
  const l = useLocation();
  return <output aria-label="Where">{l.search}</output>;
}
const sheetsOpen = () => new URLSearchParams(screen.getByLabelText("Where").textContent ?? "").getAll("sheet");

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

const FLOW_RULES = [
  rule("rate-quota", 0, { source: "owner", provider: "acme", status: ["429", "5xx"], code: ["Throttling.RateQuota"], body: "quota", hits: 312, key_effect: "Cool 60 s", request_effect: "Try next key" }),
  rule("mine", 1, {
    source: "owner",
    outcome: "fail_request",
    key_effect: "No change",
    request_effect: "Return to Caller",
    overrides: { name: "mine", status: ["429"], outcome: "cooling_key" },
    builtin_key_effect: "Cool 60 s",
  }),
  rule("server-error", 2, { enabled: false, status: ["5xx"], outcome: "retry_elsewhere", key_effect: "No change", request_effect: "Try next key", hits: 0 }),
];

function renderTab(list: Rule[] = RULES, { adding = false, post }: { adding?: boolean; post?: () => Response } = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (u, init) => {
    if (post && init?.method === "POST") return post();
    if (String(u).startsWith("/api/rules?") || ((init?.method ?? "GET") === "GET" && String(u).startsWith("/api/rules"))) return answer({ rules: list });
    return answer({ dry_run: false, audit_entry: "aud_1", changes: [], rule: list[0] });
  });
  vi.stubGlobal("fetch", fetch);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/providers/acme/rules"]}>
        <SheetStackProvider>
          <RulesTab handle="acme" adding={adding} setAdding={() => {}} />
          <Where />
        </SheetStackProvider>
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

const taken = () =>
  new Response(
    JSON.stringify({ error: { code: "name_taken", message: 'A Failure Rule named "rate-limited" exists.', hint: "Pick another name, or update that Failure Rule with PUT /api/rules/rate-limited." } }),
    { status: 409, headers: { "Content-Type": "application/json" } },
  );

test("Add rule creates only, checked or saved: the server's refusal of a taken name shows in the dialog", async () => {
  const user = userEvent.setup();
  const fetch = renderTab(RULES, { adding: true, post: taken });
  const dialog = await screen.findByRole("dialog", { name: "Add rule" });
  await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "rate-limited");
  await user.type(within(dialog).getByRole("textbox", { name: "Status" }), "429");
  const message = "A rule is already named rate-limited. Pick another name, or use Change on rate-limited to replace it.";
  await user.click(within(dialog).getByRole("button", { name: "Check against last week" }));
  expect(await within(dialog).findByText(message)).toBeTruthy();
  await user.click(within(dialog).getByRole("button", { name: "Add rule" }));
  await waitFor(() => expect(calls(fetch, "POST")).toEqual(["/api/rules?dry_run=true", "/api/rules"]));
  expect(within(dialog).getByText(message)).toBeTruthy();
  expect(fetch.mock.calls.some(([u]) => String(u).startsWith("/api/rules/rate-limited"))).toBe(false);
});

test("rules keep the order they run in: the first matching rule decides", async () => {
  renderTab();
  await screen.findByRole("table", { name: "Failure Rules" });
  expect(rows().map((r) => within(r).getAllByRole("cell")[0].textContent)).toEqual(["mine", "rate-limited", "server-error"]);
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

const flow = () => screen.findByRole("list", { name: "Failure Rules, in the order they're tried" });
const steps = () => within(screen.getByRole("list", { name: "Failure Rules, in the order they're tried" })).getAllByRole("listitem");

test("Flow shows the rules as steps in the order they're tried, and the choice is remembered", async () => {
  const user = userEvent.setup();
  renderTab();
  await screen.findByRole("table", { name: "Failure Rules" });
  await user.click(screen.getByRole("radio", { name: "Flow" }));
  await flow();
  expect(screen.queryByRole("table", { name: "Failure Rules" })).toBeNull();
  expect(steps().map((s) => within(s).getByRole("button", { name: /^Open / }).getAttribute("aria-label"))).toEqual(["Open mine", "Open rate-limited", "Open server-error"]);
  expect(localStorage.getItem("iroha:rules:view")).toBe("flow");

  cleanup();
  renderTab();
  await flow();
});

test("each step says what it matches and, on a match, what happens to the key and the Request", async () => {
  localStorage.setItem("iroha:rules:view", "flow");
  renderTab(FLOW_RULES);
  await flow();
  const [quota, mine, off] = steps();
  expect(quota.textContent).toContain("429 or 5xx and code Throttling.RateQuota and body has “quota”");
  expect(quota.textContent).toContain("Cool 60 s");
  expect(quota.textContent).toContain("Try next key");
  expect(quota.textContent).toContain("matches");
  expect(within(mine).getByText("Replaces built-in")).toBeTruthy();
  expect(mine.textContent).toContain("Built-in did: Cool 60 s");
  expect(mine.textContent).toContain("Return to Caller");
  expect(within(off).getByText("Off, skipped")).toBeTruthy();
  expect(off.textContent).toContain("skipped");
  expect(off.textContent).not.toContain("matches");
  expect(within(quota).getByText("312")).toBeTruthy();
  expect(screen.getByText("No response or 5xx: try the next key")).toBeTruthy();
  expect(screen.getByText("Anything else: return the error to the Caller")).toBeTruthy();
});

test("clicking a step opens the rule's sheet, as a table row does", async () => {
  const user = userEvent.setup();
  localStorage.setItem("iroha:rules:view", "flow");
  renderTab(FLOW_RULES);
  await flow();
  await user.click(screen.getByRole("button", { name: "Open mine" }));
  await waitFor(() => expect(sheetsOpen()).toEqual(["rule:acme/mine"]));
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("on a phone each step carries what a match does inside it, so the list still reads as a flow", async () => {
  localStorage.setItem("iroha:rules:view", "flow");
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(max-width: 767px)", media: q, addEventListener() {}, removeEventListener() {} }));
  renderTab(FLOW_RULES);
  await flow();
  const [quota, , off] = steps();
  expect(quota.textContent).toContain("If it matches");
  expect(quota.textContent).toContain("Cool 60 s");
  expect(off.textContent).toContain("Would, if it were on");
});

test("an agent switches to Flow and opens a rule from it", async () => {
  renderTab();
  await screen.findByRole("table", { name: "Failure Rules" });
  const toFlow = await agent.act({ steps: [{ ref: "View", action: "setValue", args: ["flow"] }] });
  expect(toFlow.ok, toFlow.error?.message).toBe(true);
  await flow();
  const entries = agent.snapshot().filter((e) => !e.offPage && e.component !== "more");
  for (const e of entries) expect(e.label, `${e.component} ${e.ref} has no name`).toBeTruthy();
  const labels = entries.map((e) => e.label);
  for (const l of ["View", "Open mine", "Open rate-limited", "Open server-error", "server-error on"]) expect(labels, `${l} is missing`).toContain(l);
  const run = await agent.act({ steps: [{ ref: "Open server-error", action: "press" }] });
  expect(run.ok, run.error?.message).toBe(true);
  await waitFor(() => expect(sheetsOpen()).toEqual(["rule:acme/server-error"]));
});

test("an agent opens a built-in rule's sheet from its row", async () => {
  renderTab();
  await screen.findByRole("table", { name: "Failure Rules" });
  const entries = agent.snapshot().filter((e) => !e.offPage && e.component !== "more");
  for (const e of entries) expect(e.label, `${e.component} ${e.ref} has no name`).toBeTruthy();
  const labels = entries.map((e) => e.label);
  for (const l of ["Open mine", "More for mine", "mine on", "Open rate-limited"]) expect(labels, `${l} is missing`).toContain(l);
  const run = await agent.act({ steps: [{ ref: "Open rate-limited", action: "press" }] });
  expect(run.ok, run.error?.message).toBe(true);
  await waitFor(() => expect(sheetsOpen()).toEqual(["rule:acme/rate-limited"]));
});
