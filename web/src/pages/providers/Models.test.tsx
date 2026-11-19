import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createAgent } from "@ui-sdk/react/agent";
import { afterEach, expect, test, vi } from "vitest";
import { ModelsTab } from "./Models";

const agent = createAgent();
const { openChat } = vi.hoisted(() => ({ openChat: vi.fn() }));
vi.mock("@/app/chat-panel", () => ({ useChatPanel: () => ({ open: openChat }) }));

const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

const model = (id: string, o: { added: boolean; discovered: boolean }) => ({
  id,
  model: id,
  ...o,
  hidden: false,
  visible: true,
  endpoints: [],
  upstream_keys: [],
  model_gaps: [],
  metadata: {},
  overrides: {},
  reported: {},
  models_dev: {},
});

function renderTab() {
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const u = String(url);
    if (u.startsWith("/api/providers/acme/keys")) return answer({ upstream_keys: [] });
    if (u.startsWith("/api/providers/acme/models") && (init?.method ?? "GET") === "GET")
      return answer({
        provider: "acme",
        discovery: "list",
        strict: false,
        counts: { all: 2, visible: 2, discovered: 1, added: 2, hidden: 0, gaps: 0 },
        total: 2,
        offset: 0,
        limit: 50,
        models: [model("my-model", { added: true, discovered: false }), model("pinned-model", { added: true, discovered: true })],
      });
    return answer({ dry_run: false, changes: [], model: model("my-model", { added: false, discovered: false }) });
  });
  vi.stubGlobal("fetch", fetch);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ModelsTab handle="acme" />
    </QueryClientProvider>,
  );
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
  openChat.mockClear();
});

const posts = (fetch: ReturnType<typeof renderTab>) => fetch.mock.calls.filter(([, init]) => init?.method === "POST");

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

test("an agent tests a model from its row menu", async () => {
  renderTab();
  await screen.findByRole("button", { name: "More for my-model" });
  const run = await agent.act({ steps: [{ ref: "More for my-model", action: "press", args: ["Test in Chat"] }] });
  expect(run.ok, run.error?.message).toBe(true);
  expect(openChat).toHaveBeenCalledExactlyOnceWith({ kind: "model", provider: "acme", model: "my-model" });
});
