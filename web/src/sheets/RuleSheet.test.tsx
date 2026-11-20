import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgent } from "@ui-sdk/react/agent";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Rule } from "@/pages/providers/api";
import { RulesTab } from "@/pages/providers/Rules";
import { loadedSheet, renderWithSheets, routes } from "./test-iroha";

// UI ticket 33: an existing Failure Rule opens in its own sheet (it was the
// Rules tab's edit dialog): the rule in words as the Flow view shows it,
// today's hits, Edit in place, and Restore built-in / Delete asking first.

let approve = false;
const agent = createAgent({ allow: (step) => !step.confirm || approve });
const where = () => screen.getByRole("status", { name: "Location" }).textContent;
const text = { ignore: "script, style, [data-ui-sdk-announcer]" };
const saved = { ...routes };

const rule = (name: string, i: number, o: Partial<Rule> = {}): Rule => ({
  name,
  enabled: true,
  source: "builtin",
  status: ["429"],
  outcome: "cooling_key",
  key_effect: "Cool 60 s",
  request_effect: "Try next key",
  hits: i,
  order: i,
  ...o,
});
const RULES = [
  rule("rate-quota", 0, { source: "owner", provider: "acme", status: ["429", "5xx"], code: ["Throttling.RateQuota"], body: "quota", hits: 312, description: "DashScope's quota" }),
  rule("mine", 1, { source: "owner", outcome: "fail_request", key_effect: "No change", request_effect: "Return to Caller", hits: 4, overrides: { name: "mine", status: ["429"], outcome: "cooling_key" }, builtin_key_effect: "Cool 60 s" }),
  rule("server-error", 2, { status: ["5xx"], outcome: "retry_elsewhere", key_effect: "No change", hits: 20 }),
];
const result = (r: Rule) => ({ dry_run: false, audit_entry: "aud_1", changes: [], rule: r });

beforeEach(() => {
  localStorage.clear();
  routes["GET /api/rules"] = { rules: RULES };
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of Object.keys(routes)) if (!(k in saved)) delete routes[k];
  Object.assign(routes, saved);
  approve = false;
});

async function ruleSheet(name: string) {
  const sheet = await loadedSheet(`Failure Rule ${name}`);
  await within(sheet).findByRole("switch", { name: `${name} on` });
  return sheet;
}

const sent = (fetch: ReturnType<typeof renderWithSheets>["fetch"], method: string) =>
  fetch.mock.calls.filter(([, i]) => i?.method === method).map(([u, i]) => [String(u), i?.body ? JSON.parse(String(i.body)) : undefined]);

test("a rule's sheet says it in words as the Flow view does, with its place in the order and today's hits", async () => {
  renderWithSheets(null, "/x?sheet=rule:acme/rate-quota");
  const sheet = await ruleSheet("rate-quota");
  const s = within(sheet);
  expect(sheet.textContent).toContain("429 or 5xx and code Throttling.RateQuota and body has “quota”");
  expect(sheet.textContent).toContain("Tried early: only acme");
  expect(sheet.textContent).toContain("If it matches");
  expect(sheet.textContent).toContain("Cool 60 s");
  expect(sheet.textContent).toContain("Try next key");
  expect(sheet.textContent).toContain("312");
  expect(sheet.textContent).toContain("1 of 3");
  expect(sheet.textContent).toContain("DashScope's quota");
  expect(s.getByRole("link", { name: "acme" })).toBeTruthy();
  expect(s.getByRole("link", { name: "Open page" }).getAttribute("href")).toBe("/providers/acme/rules?sheet=rule%3Aacme%2Frate-quota");
  // No button over the step: the sheet is the rule already.
  expect(s.queryByRole("button", { name: "Open rate-quota" })).toBeNull();
});

test("Edit turns the sheet into the rule's fields; Save changes the Owner's rule in place and says so in the sheet", async () => {
  const user = userEvent.setup();
  routes["PATCH /api/rules/rate-quota"] = result(RULES[0]);
  const { fetch } = renderWithSheets(null, "/x?sheet=rule:acme/rate-quota");
  const s = within(await ruleSheet("rate-quota"));
  await user.click(s.getByRole("button", { name: "Edit rate-quota" }));
  const body = await s.findByRole("textbox", { name: "Body contains" });
  expect((body as HTMLInputElement).value).toBe("quota");
  expect((s.getByRole("textbox", { name: "Name" }) as HTMLInputElement).disabled).toBe(true);
  expect(screen.queryAllByRole("dialog")).toHaveLength(1);
  await user.clear(body);
  await user.type(body, "quota exceeded");
  await user.click(s.getByRole("button", { name: "Save rule" }));
  await waitFor(() => expect(sent(fetch, "PATCH")).toHaveLength(1));
  const [u, sentBody] = sent(fetch, "PATCH")[0];
  expect(u).toBe("/api/rules/rate-quota");
  expect(sentBody).toMatchObject({ body: "quota exceeded", status: ["429", "5xx"], code: ["Throttling.RateQuota"], outcome: "cooling_key", provider: "acme" });
  expect(await s.findByText("rate-quota saved", text)).toBeTruthy();
  await waitFor(() => expect(s.queryByRole("textbox", { name: "Body contains" })).toBeNull());
});

test("Change on a built-in rule saves the Owner's rule of its name; Check against last week shows the replay in the sheet", async () => {
  const user = userEvent.setup();
  routes["POST /api/rules"] = { ...result(RULES[2]), replay: { attempts: 40, changed: 3, since: "2026-11-12T00:00:00Z", rules: [] } };
  const { fetch } = renderWithSheets(null, "/x?sheet=rule:acme/server-error");
  const s = within(await ruleSheet("server-error"));
  expect(s.queryByRole("button", { name: /^Delete/ })).toBeNull();
  await user.click(s.getByRole("button", { name: "Change server-error" }));
  await user.click(await s.findByRole("button", { name: "Check against last week" }));
  expect(await s.findByText("3 of the last 7 days' 40 failed Attempts would be decided differently.")).toBeTruthy();
  await user.click(s.getByRole("button", { name: "Save rule" }));
  await waitFor(() => expect(sent(fetch, "POST")).toHaveLength(2));
  expect(sent(fetch, "POST").map(([u]) => u)).toEqual(["/api/rules?dry_run=true", "/api/rules"]);
  expect(sent(fetch, "POST")[1][1]).toMatchObject({ name: "server-error", status: ["5xx"], outcome: "retry_elsewhere" });
});

test("Restore the built-in asks and keeps the sheet; Delete asks and closes it", async () => {
  const user = userEvent.setup();
  routes["DELETE /api/rules/mine"] = result(RULES[1]);
  routes["DELETE /api/rules/rate-quota"] = result(RULES[0]);
  const { fetch } = renderWithSheets(null, "/x?sheet=rule:acme/mine");
  const s = within(await ruleSheet("mine"));
  expect(s.getAllByText("Replaces built-in").length).toBeGreaterThan(0);
  expect(s.getAllByText(/Built-in did/).length).toBeGreaterThan(0);
  const restore = s.getByRole("button", { name: "Restore the built-in mine…" });
  expect(restore.hasAttribute("data-danger")).toBe(true);
  await user.click(restore);
  await user.click(within(await screen.findByRole("alertdialog", { name: "Restore the built-in mine?" })).getByRole("button", { name: "Restore built-in" }));
  await waitFor(() => expect(sent(fetch, "DELETE")).toEqual([["/api/rules/mine", undefined]]));
  expect(await s.findByText("mine restored", text)).toBeTruthy();
  expect(where()).toBe("/x?sheet=rule:acme/mine");

  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryAllByRole("dialog")).toHaveLength(0));
});

test("Delete on the Owner's own rule asks, then the rule's sheet closes", async () => {
  const user = userEvent.setup();
  routes["DELETE /api/rules/rate-quota"] = result(RULES[0]);
  const { fetch } = renderWithSheets(null, "/x?sheet=provider:acme&sheet=rule:acme/rate-quota");
  const s = within(await ruleSheet("rate-quota"));
  await user.click(s.getByRole("button", { name: "Delete rate-quota…" }));
  await user.click(within(await screen.findByRole("alertdialog", { name: "Delete rate-quota?" })).getByRole("button", { name: "Delete rule" }));
  await waitFor(() => expect(sent(fetch, "DELETE")).toEqual([["/api/rules/rate-quota", undefined]]));
  await waitFor(() => expect(where()).toBe("/x?sheet=provider:acme"));
});

test("a rule that doesn't apply to the Provider says so", async () => {
  renderWithSheets(null, "/x?sheet=rule:acme/nope");
  expect(await screen.findByRole("dialog", { name: "No Failure Rule nope for acme" })).toBeTruthy();
});

function rulesTab() {
  return renderWithSheets(<RulesTab handle="acme" adding={false} setAdding={() => {}} />, "/providers/acme/rules");
}

test("the Rules tab: a row and a Flow step open the rule's sheet; Edit… opens it on its fields", async () => {
  const user = userEvent.setup();
  rulesTab();
  await user.click(await screen.findByRole("button", { name: "Open rate-quota" }));
  await ruleSheet("rate-quota");
  await waitFor(() => expect(where()).toBe("/providers/acme/rules?sheet=rule:acme/rate-quota"));
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryAllByRole("dialog")).toHaveLength(0));

  await user.click(screen.getByRole("button", { name: "More for mine" }));
  await user.click(await screen.findByRole("menuitem", { name: "Edit…" }));
  const editing = await ruleSheet("mine");
  expect(await within(editing).findByRole("textbox", { name: "Body contains" })).toBeTruthy();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryAllByRole("dialog")).toHaveLength(0));

  await user.click(screen.getByRole("radio", { name: "Flow" }));
  await screen.findByRole("list", { name: "Failure Rules, in the order they're tried" });
  await user.click(screen.getByRole("button", { name: "Open server-error" }));
  await ruleSheet("server-error");
  expect(screen.queryByRole("dialog", { name: "Change server-error" })).toBeNull();
});

test("an agent opens a rule from the Flow view, edits it in the sheet and needs a person to delete it", async () => {
  localStorage.setItem("iroha:rules:view", "flow");
  routes["PATCH /api/rules/rate-quota"] = result(RULES[0]);
  routes["DELETE /api/rules/rate-quota"] = result(RULES[0]);
  const { fetch } = rulesTab();
  await screen.findByRole("list", { name: "Failure Rules, in the order they're tried" });
  const open = await agent.act({ steps: [{ ref: "Open rate-quota", action: "press" }] });
  expect(open.ok, open.error?.message).toBe(true);
  const sheet = await ruleSheet("rate-quota");
  const entries = agent.snapshot().filter((e) => !e.offPage && e.component !== "more" && e.component !== "scroll-area");
  for (const e of entries) expect(e.label, `${e.component} ${e.ref} has no name`).toBeTruthy();
  const labels = entries.map((e) => e.label);
  for (const l of ["Edit rate-quota", "rate-quota on", "Delete rate-quota…", "Open page"]) expect(labels, `${l} is missing`).toContain(l);

  const edit = await agent.act({ steps: [{ ref: "Edit rate-quota", action: "press" }] });
  expect(edit.ok, edit.error?.message).toBe(true);
  await within(sheet).findByRole("textbox", { name: "Status" });
  const fields = agent.snapshot().map((e) => e.label);
  for (const l of ["Status", "Error code", "Body contains", "Then", "Description", "Check against last week", "Save rule", "Cancel"]) expect(fields, `${l} is missing`).toContain(l);
  const save = await agent.act({ steps: [{ ref: "Save rule", action: "press" }] });
  expect(save.ok, save.error?.message).toBe(true);
  await waitFor(() => expect(sent(fetch, "PATCH")).toHaveLength(1));

  const remove = { steps: [{ ref: "Delete rate-quota…", action: "press" }, { ref: "Delete rate-quota?", action: "press", args: ["Delete rule"] }] };
  expect((await agent.act(remove)).ok).toBe(false);
  expect(sent(fetch, "DELETE")).toHaveLength(0);
});
