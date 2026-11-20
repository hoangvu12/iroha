import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createAgent } from "@ui-sdk/react/agent";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Toaster } from "@/ui/toast";
import type { Model } from "./api";
import { ModelsTab } from "./Models";
import { SheetStackProvider } from "@/sheets/stack";

const agent = createAgent();
const { openChat } = vi.hoisted(() => ({ openChat: vi.fn() }));
vi.mock("@/app/chat-panel", () => ({ useChatActions: () => ({ open: openChat, close() {}, toggle() {} }) }));

const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

const model = (id: string, o: Partial<Model> = {}): Model => ({
  id,
  model: id,
  added: false,
  discovered: true,
  hidden: false,
  visible: true,
  endpoints: [],
  upstream_keys: [],
  model_gaps: [],
  metadata: {},
  overrides: {},
  reported: {},
  models_dev: {},
  ...o,
});

const TWO = [model("my-model", { added: true, discovered: false }), model("pinned-model", { added: true, discovered: true })];

function Where() {
  const l = useLocation();
  return <output aria-label="Where">{l.search}</output>;
}

/** A fake Iroha that filters, searches and pages `all` the way GET /api/providers/{p}/models does. */
function renderTab(all: Model[] = TWO, url = "/providers/acme/models") {
  const fetch = vi.fn<typeof globalThis.fetch>(async (u, init) => {
    const where = new URL(String(u), "http://iroha.test");
    if (where.pathname === "/api/providers/acme/keys") return answer({ upstream_keys: [] });
    if (where.pathname === "/api/providers/acme/models" && (init?.method ?? "GET") === "GET") {
      const q = where.searchParams.get("q") ?? "";
      const filter = where.searchParams.get("filter") ?? "all";
      const offset = Number(where.searchParams.get("offset") ?? 0);
      const limit = Number(where.searchParams.get("limit") ?? 100);
      const matching = all.filter((m) => m.model.includes(q) && (filter === "all" || (filter === "hidden" ? m.hidden : filter === "added" ? m.added : true)));
      return answer({
        provider: "acme",
        discovery: "provider",
        strict: false,
        counts: { all: all.length, visible: all.length, discovered: all.filter((m) => m.discovered).length, added: all.filter((m) => m.added).length, hidden: 0, gaps: 0 },
        total: matching.length,
        offset,
        limit,
        models: matching.slice(offset, offset + limit),
      });
    }
    if (where.pathname === "/api/providers/acme/models/bulk") {
      const items: unknown[] = JSON.parse(String(init?.body)).items;
      return answer({ dry_run: false, audit_entry: "aud_1", succeeded: items.length, failed: 0, items: items.map((_, index) => ({ index, ok: true, outcome: "updated", changes: [] })) });
    }
    return answer({ dry_run: false, changes: [], model: model("my-model", { added: false, discovered: false }) });
  });
  vi.stubGlobal("fetch", fetch);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <SheetStackProvider>
          <ModelsTab handle="acme" />
          <Where />
        </SheetStackProvider>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  );
  return fetch;
}

const posts = (fetch: ReturnType<typeof renderTab>) => fetch.mock.calls.filter(([, init]) => init?.method === "POST");
const listCalls = (fetch: ReturnType<typeof renderTab>) =>
  fetch.mock.calls.map(([u]) => new URL(String(u), "http://iroha.test")).filter((u) => u.pathname === "/api/providers/acme/models" && u.searchParams.has("offset"));
const rows = () => within(screen.getByRole("table", { name: "Models" })).getAllByRole("row").slice(1);
const where = () => screen.getByLabelText("Where").textContent ?? "";
const many = (n: number) => Array.from({ length: n }, (_, i) => model(`m-${String(i + 1).padStart(4, "0")}`));

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  openChat.mockClear();
});

test("thousands of models come a page at a time from the server, in numbered pages", async () => {
  const user = userEvent.setup();
  const fetch = renderTab(many(2400));
  await waitFor(() => expect(rows()).toHaveLength(25));
  expect(listCalls(fetch).at(-1)?.searchParams.get("limit")).toBe("25");
  expect(screen.getByText("1–25 of 2,400 models")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Page 2" }));
  await waitFor(() => expect(within(rows()[0]).getByText("m-0026")).toBeTruthy());
  expect(listCalls(fetch).at(-1)?.searchParams.get("offset")).toBe("25");
  // A bigger page asks for more from the start, and is remembered for this table.
  await user.click(screen.getByRole("combobox", { name: "Rows per page" }));
  await user.click(await screen.findByRole("option", { name: "100 per page" }));
  await waitFor(() => expect(rows()).toHaveLength(100));
  expect(listCalls(fetch).at(-1)?.searchParams.get("offset")).toBe("0");
  expect(localStorage.getItem("iroha:table:provider-models:page-size")).toBe("100");
});

test("the filter and the search go to the server and live in the URL", async () => {
  const user = userEvent.setup();
  const fetch = renderTab([...TWO, model("other")]);
  await waitFor(() => expect(rows()).toHaveLength(3));
  await user.click(screen.getByRole("radio", { name: /Added/ }));
  await waitFor(() => expect(rows()).toHaveLength(2));
  expect(where()).toContain("filter=added");
  expect(listCalls(fetch).at(-1)?.searchParams.get("filter")).toBe("added");
  await user.type(screen.getByRole("searchbox", { name: "Search models" }), "pinned");
  await waitFor(() => expect(rows()).toHaveLength(1));
  expect(where()).toContain("q=pinned");
  expect(listCalls(fetch).at(-1)?.searchParams.get("q")).toBe("pinned");
});

test("the six filters of the model list are offered", async () => {
  renderTab();
  const group = await screen.findByRole("radiogroup", { name: "Show models" });
  const names = within(group).getAllByRole("radio").map((r) => r.textContent?.replace(/\d+$/, ""));
  expect(names).toEqual(["All", "Listed", "Discovered", "Added", "Hidden", "With Model Gaps"]);
});

test("selected models are hidden together through the bulk API, with the result in the bar", async () => {
  const user = userEvent.setup();
  const fetch = renderTab();
  await user.click(await screen.findByRole("checkbox", { name: "Select all rows on this page" }));
  const bar = screen.getByRole("group", { name: "2 selected" });
  await user.click(within(bar).getByRole("button", { name: "Hide" }));
  await waitFor(() => expect(posts(fetch)).toHaveLength(1));
  const [url, init] = posts(fetch)[0];
  expect(String(url)).toBe("/api/providers/acme/models/bulk");
  expect(JSON.parse(String(init?.body))).toEqual({ items: [{ model: "my-model", hidden: true }, { model: "pinned-model", hidden: true }] });
  expect(await within(bar).findByText("2 models hidden", { ignore: "script, style, [data-ui-sdk-announcer]" })).toBeTruthy();
});

test("Edit… works on models selected on several pages: mixed values shown, and each model keeps its own other overrides", async () => {
  const user = userEvent.setup();
  const all = many(30).map((m, i) => (i === 0 ? { ...m, overrides: { context_length: 8000, chat: "ok" as const } } : i === 26 ? { ...m, hidden: true, overrides: { chat: "ok" as const } } : m));
  const fetch = renderTab(all);
  await user.click(await screen.findByRole("checkbox", { name: "Select m-0001" }));
  await user.click(screen.getByRole("button", { name: "Page 2" }));
  await user.click(await screen.findByRole("checkbox", { name: "Select m-0027" }));
  const bar = screen.getByRole("group", { name: "2 selected" });
  await user.click(within(bar).getByRole("button", { name: "Edit…" }));
  const dialog = await screen.findByRole("dialog", { name: "Edit 2 models" });
  expect(within(dialog).getByRole("checkbox", { name: "Hidden from Callers" }).getAttribute("aria-checked")).toBe("mixed");
  expect(within(dialog).getByRole("combobox", { name: "Chat" }).textContent).toContain("Chats");
  expect((within(dialog).getByRole("textbox", { name: "Context window" }) as HTMLInputElement).placeholder).toBe("Mixed");
  await user.type(within(dialog).getByRole("textbox", { name: "Max output" }), "4096");
  await user.click(within(dialog).getByRole("button", { name: "Apply to 2 models" }));
  await waitFor(() => expect(posts(fetch)).toHaveLength(1));
  expect(JSON.parse(String(posts(fetch)[0][1]?.body))).toEqual({
    items: [
      { model: "m-0001", metadata: { context_length: 8000, chat: "ok", max_output_tokens: 4096 } },
      { model: "m-0027", metadata: { chat: "ok", max_output_tokens: 4096 } },
    ],
  });
  expect(await within(bar).findByText("2 models changed", { ignore: "script, style, [data-ui-sdk-announcer]" })).toBeTruthy();
});

test("removing a model the Owner added is red and asks first, naming the model; Cancel keeps it", async () => {
  const user = userEvent.setup();
  const fetch = renderTab();
  await user.click(await screen.findByRole("button", { name: "More for my-model" }));
  const item = await screen.findByRole("menuitem", { name: "Remove from the list…" });
  expect(item.hasAttribute("data-destructive")).toBe(true);
  await user.click(item);
  await screen.findByRole("alertdialog", { name: "Remove my-model from acme?" });
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(posts(fetch)).toHaveLength(0);

  await user.click(screen.getByRole("button", { name: "More for my-model" }));
  await user.click(await screen.findByRole("menuitem", { name: "Remove from the list…" }));
  await user.click(await screen.findByRole("button", { name: "Remove model" }));
  await waitFor(() => expect(posts(fetch)).toHaveLength(1));
  const [url, init] = posts(fetch)[0];
  expect(String(url)).toBe("/api/providers/acme/models");
  expect(JSON.parse(String(init?.body))).toEqual({ model: "my-model", added: false });
});

test("unpinning a discovered model keeps it listed, so it acts at once", async () => {
  const user = userEvent.setup();
  const fetch = renderTab();
  await user.click(await screen.findByRole("button", { name: "More for pinned-model" }));
  const item = await screen.findByRole("menuitem", { name: "Unpin" });
  expect(item.hasAttribute("data-destructive")).toBe(false);
  await user.click(item);
  await waitFor(() => expect(posts(fetch)).toHaveLength(1));
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

test("Test in Chat on a model row opens the chat on that model of this Provider", async () => {
  const user = userEvent.setup();
  renderTab();
  await user.click(await screen.findByRole("button", { name: "More for pinned-model" }));
  await user.click(await screen.findByRole("menuitem", { name: "Test in Chat" }));
  expect(openChat).toHaveBeenCalledExactlyOnceWith({ kind: "model", provider: "acme", model: "pinned-model" });
});

test("clicking a model's row, or its name, opens its sheet (UI ticket 33: it was a dialog)", async () => {
  const user = userEvent.setup();
  renderTab();
  await user.click(await screen.findByRole("button", { name: "Open pinned-model" }));
  await waitFor(() => expect(new URLSearchParams(where()).getAll("sheet")).toEqual(["model:acme/pinned-model"]));
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("an agent finds the model controls, pages, and tests a model from its row menu", async () => {
  renderTab(many(60));
  await screen.findByRole("button", { name: "More for m-0001" });
  const entries = agent.snapshot().filter((e) => !e.offPage && e.component !== "more");
  for (const e of entries) expect(e.label, `${e.component} ${e.ref} has no name`).toBeTruthy();
  const labels = entries.map((e) => e.label);
  for (const l of ["Search models", "Show models", "Select m-0001", "Open m-0001", "More for m-0001", "Rows per page", "Pages of Models"]) expect(labels, `${l} is missing`).toContain(l);
  const page = await agent.act({ steps: [{ ref: "Pages of Models", action: "next" }] });
  expect(page.ok, page.error?.message).toBe(true);
  await screen.findByRole("button", { name: "More for m-0026" });
  const run = await agent.act({ steps: [{ ref: "More for m-0026", action: "press", args: ["Test in Chat"] }] });
  expect(run.ok, run.error?.message).toBe(true);
  expect(openChat).toHaveBeenCalledExactlyOnceWith({ kind: "model", provider: "acme", model: "m-0026" });
});
