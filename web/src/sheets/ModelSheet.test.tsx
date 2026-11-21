import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgent } from "@ui-sdk/react/agent";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Model } from "@/pages/providers/api";
import { ModelsTab } from "@/pages/providers/Models";
import { loadedSheet, renderWithSheets, routes } from "./test-iroha";

const { openChat } = vi.hoisted(() => ({ openChat: vi.fn() }));
vi.mock("@/app/chat-panel", async (real) => ({
  ...(await real<typeof import("@/app/chat-panel")>()),
  useChatActions: () => ({ open: openChat, close() {}, toggle() {} }),
}));

const agent = createAgent();
const where = () => screen.getByRole("status", { name: "Location" }).textContent;
const text = { ignore: "script, style, [data-ui-sdk-announcer]" };
const saved = { ...routes };

const model = (id: string, o: Partial<Model> = {}): Model => ({
  id: "pm_" + id,
  model: id,
  added: false,
  discovered: true,
  hidden: false,
  visible: true,
  endpoints: ["main"],
  upstream_keys: [],
  model_gaps: [],
  metadata: { context_length: 128000, chat: "ok" },
  overrides: {},
  reported: { context_length: 128000 },
  models_dev: {},
  discovered_at: "2026-11-19T09:00:00Z",
  ...o,
});
const fast = model("gpt-fast", { model_gaps: ["team-5"] });
const llama = model("meta/llama-3", { metadata: { context_length: 8000 }, overrides: { context_length: 8000 }, reported: {} });

beforeEach(() => {
  routes["GET /api/providers/acme/models/gpt-fast"] = fast;
  routes["GET /api/providers/acme/models/meta%2Fllama-3"] = llama;
  routes["GET /api/pools"] = {
    pools: [
      routes["GET /api/pools/fast"],
      { id: "pl2", name: "cheap", maker: "", maker_guessed: true, members: [{ position: 1, provider: "other", model: "gpt-fast", enabled: true }], budget: { max_attempts: 3, first_byte_seconds: 30 }, created_at: "2026-11-19T10:00:00Z" },
    ],
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
  openChat.mockClear();
  for (const k of Object.keys(routes)) if (!(k in saved)) delete routes[k];
  Object.assign(routes, saved);
});

async function modelSheet(name: string) {
  const sheet = await loadedSheet(`Model ${name}`);
  await within(sheet).findByRole("button", { name: `Test ${name} in Chat` });
  return sheet;
}

const sent = (fetch: ReturnType<typeof renderWithSheets>["fetch"], method: string) =>
  fetch.mock.calls.filter(([, i]) => i?.method === method).map(([u, i]) => [String(u), i?.body ? JSON.parse(String(i.body)) : undefined]);

test("a model's sheet shows what the details dialog did, its Provider, Model Gaps and the Pools that use it", async () => {
  const user = userEvent.setup();
  renderWithSheets(null, "/x?sheet=model:acme/gpt-fast");
  const sheet = await modelSheet("gpt-fast");
  const s = within(sheet);

  expect(s.getByRole("link", { name: "acme" }).getAttribute("href")).toBe("/x?sheet=model%3Aacme%2Fgpt-fast&sheet=provider%3Aacme");
  expect(sheet.textContent).toContain("Listed");
  expect(sheet.textContent).toContain("128K");
  expect(sheet.textContent).toContain("from acme's list");
  expect(sheet.textContent).toContain("main");
  expect(s.getByRole("link", { name: "team-5" }).getAttribute("href")).toContain("sheet=key%3Aacme%2Fteam-5");
  expect(s.getByRole("button", { name: "Clear the Model Gaps of gpt-fast" })).toBeTruthy();
  expect(await s.findByRole("link", { name: "fast" })).toBeTruthy();
  expect(s.queryByRole("link", { name: "cheap" })).toBeNull();
  expect(s.getByRole("link", { name: "Open page" }).getAttribute("href")).toBe("/providers/acme/models?sheet=model%3Aacme%2Fgpt-fast");

  await user.click(s.getByRole("button", { name: "Test gpt-fast in Chat" }));
  expect(openChat).toHaveBeenCalledExactlyOnceWith({ kind: "model", provider: "acme", model: "gpt-fast" });
});

test("a model ID with a slash loads by its escaped ID", async () => {
  const { fetch } = renderWithSheets(null, "/x?sheet=model:acme/meta/llama-3");
  const sheet = await modelSheet("meta/llama-3");
  expect(fetch.mock.calls.map(([u]) => String(u))).toContain("/api/providers/acme/models/meta%2Fllama-3");
  expect(sheet.textContent).toContain("8K");
  expect(sheet.textContent).toContain("from you");
});

test("a model neither discovered nor added is not said to be added by hand", async () => {
  routes["GET /api/providers/acme/models/gpt-ghost"] = model("gpt-ghost", { discovered: false, added: false, visible: false, endpoints: [], overrides: { context_length: 8000 } });
  renderWithSheets(null, "/x?sheet=model:acme/gpt-ghost");
  const sheet = await modelSheet("gpt-ghost");
  expect(sheet.textContent).toContain("Not listed");
  expect(sheet.textContent).not.toContain("added by hand");
  expect(sheet.textContent).toContain("Nobody: only your details for it are kept");
});

test("Edit details turns the facts into fields; Save sends the overrides and says so in the sheet", async () => {
  const user = userEvent.setup();
  routes["POST /api/providers/acme/models"] = { audit_entry: "aud_1", changes: [], model: fast };
  const { fetch } = renderWithSheets(null, "/x?sheet=model:acme/gpt-fast");
  const s = within(await modelSheet("gpt-fast"));

  await user.click(s.getByRole("button", { name: "Edit details" }));
  const max = await s.findByRole("textbox", { name: "Max output" });
  await user.type(max, "16,384");
  await user.click(s.getByRole("button", { name: "Save details" }));
  await waitFor(() => expect(sent(fetch, "POST")).toEqual([["/api/providers/acme/models", { model: "gpt-fast", metadata: { max_output_tokens: 16384 } }]]));
  expect(await s.findByText("gpt-fast details saved", text)).toBeTruthy();
  await waitFor(() => expect(s.queryByRole("textbox", { name: "Max output" })).toBeNull());
  expect(screen.queryAllByRole("dialog")).toHaveLength(1);
});

test("Hide and Pin act at once and show their result in the sheet", async () => {
  const user = userEvent.setup();
  routes["POST /api/providers/acme/models"] = { audit_entry: "aud_1", changes: [], model: fast };
  const { fetch } = renderWithSheets(null, "/x?sheet=model:acme/gpt-fast");
  const s = within(await modelSheet("gpt-fast"));
  await user.click(s.getByRole("button", { name: "Hide gpt-fast" }));
  expect(await s.findByText("gpt-fast hidden", text)).toBeTruthy();
  await user.click(s.getByRole("button", { name: "Pin gpt-fast to the list" }));
  expect(await s.findByText("gpt-fast pinned to the list", text)).toBeTruthy();
  expect(sent(fetch, "POST")).toEqual([
    ["/api/providers/acme/models", { model: "gpt-fast", hidden: true }],
    ["/api/providers/acme/models", { model: "gpt-fast", added: true }],
  ]);
});

test("removing a model only the Owner added asks first, then closes its sheet", async () => {
  const user = userEvent.setup();
  routes["GET /api/providers/acme/models/gpt-fast"] = model("gpt-fast", { added: true, discovered: false, endpoints: [] });
  routes["POST /api/providers/acme/models"] = { audit_entry: "aud_1", changes: [], model: fast };
  const { fetch } = renderWithSheets(null, "/x?sheet=provider:acme&sheet=model:acme/gpt-fast");
  const s = within(await modelSheet("gpt-fast"));
  const remove = s.getByRole("button", { name: "Remove gpt-fast from the list…" });
  expect(remove.hasAttribute("data-danger")).toBe(true);
  await user.click(remove);
  await user.click(within(await screen.findByRole("alertdialog", { name: "Remove gpt-fast from acme?" })).getByRole("button", { name: "Remove model" }));
  await waitFor(() => expect(sent(fetch, "POST")).toEqual([["/api/providers/acme/models", { model: "gpt-fast", added: false }]]));
  await waitFor(() => expect(where()).toBe("/x?sheet=provider:acme"));
});

test("a model the list doesn't hold says so and offers to add it", async () => {
  const user = userEvent.setup();
  routes["POST /api/providers/acme/models"] = { audit_entry: "aud_1", changes: [], model: fast };
  const { fetch } = renderWithSheets(null, "/x?sheet=model:acme/gpt-new");
  const sheet = await screen.findByRole("dialog", { name: "No model gpt-new on acme" });
  await user.click(await within(sheet).findByRole("button", { name: "Add gpt-new to acme's list" }));
  await waitFor(() => expect(sent(fetch, "POST")).toEqual([["/api/providers/acme/models", { model: "gpt-new", added: true }]]));
});

function modelsTab() {
  routes["GET /api/providers/acme/models"] = { provider: "acme", discovery: "provider", strict: false, counts: { all: 1, visible: 1, discovered: 1, added: 0, hidden: 0, gaps: 1 }, total: 1, offset: 0, limit: 25, models: [fast] };
  return renderWithSheets(<ModelsTab handle="acme" />, "/providers/acme/models");
}

test("the Models tab: a row opens the model's sheet, Details… opens it on its fields", async () => {
  const user = userEvent.setup();
  modelsTab();
  await user.click(await screen.findByRole("button", { name: "Open gpt-fast" }));
  await modelSheet("gpt-fast");
  await waitFor(() => expect(where()).toBe("/providers/acme/models?sheet=model:acme/gpt-fast"));
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryAllByRole("dialog")).toHaveLength(0));

  await user.click(screen.getByRole("button", { name: "More for gpt-fast" }));
  await user.click(await screen.findByRole("menuitem", { name: "Details…" }));
  const sheet = await modelSheet("gpt-fast");
  expect(await within(sheet).findByRole("textbox", { name: "Context window" })).toBeTruthy();
});

test("an agent opens a model from the Models tab and finds its actions and fields by name", async () => {
  modelsTab();
  await screen.findByRole("table", { name: "Models" });
  const run = await agent.act({ steps: [{ ref: "Open gpt-fast", action: "press" }] });
  expect(run.ok, run.error?.message).toBe(true);
  const sheet = await modelSheet("gpt-fast");
  const entries = agent.snapshot().filter((e) => !e.offPage && e.component !== "more" && e.component !== "scroll-area");
  for (const e of entries) expect(e.label, `${e.component} ${e.ref} has no name`).toBeTruthy();
  const labels = entries.map((e) => e.label);
  for (const l of ["Test gpt-fast in Chat", "Hide gpt-fast", "Pin gpt-fast to the list", "Edit details", "Open page"]) expect(labels, `${l} is missing`).toContain(l);
  const edit = await agent.act({ steps: [{ ref: "Edit details", action: "press" }] });
  expect(edit.ok, edit.error?.message).toBe(true);
  await within(sheet).findByRole("textbox", { name: "Context window" });
  const fields = agent.snapshot().map((e) => e.label);
  for (const l of ["Context window", "Max output", "Reasons before answering", "Chat", "Save details", "Cancel"]) expect(fields, `${l} is missing`).toContain(l);
});
