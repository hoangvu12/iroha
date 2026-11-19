import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgent } from "@ui-sdk/react/agent";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Pool } from "./api";
import { PoolMembersTab } from "./PoolMembers";

const agent = createAgent();
const { openChat } = vi.hoisted(() => ({ openChat: vi.fn() }));
vi.mock("@/app/chat-panel", () => ({ useChatPanel: () => ({ open: openChat }) }));

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

const pool: Pool = {
  id: "pool_1",
  name: "fast",
  maker: "",
  maker_guessed: true,
  members: [
    { position: 1, provider: "acme", model: "m-1", enabled: true },
    { position: 2, provider: "zeta", model: "qwen/m-2", enabled: true },
  ],
  budget: { max_attempts: 3, first_byte_seconds: 30 },
  created_at: "2026-11-19T00:00:00Z",
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = new URL(url, "http://iroha.test");
      if (u.pathname === "/api/overview") return json({ since: "2026-11-19T00:00:00Z", providers: [], pools: [] });
      if (u.pathname === "/api/gateway-keys") return json({ gateway_keys: [] });
      return new Response("{}", { status: 404 });
    }),
  );
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
    </QueryClientProvider>,
  );
  await screen.findByRole("button", { name: "More for member 1" });
}

test("Test in Chat on a member opens the chat on its Provider and model", async () => {
  const user = userEvent.setup();
  await renderTab();
  await user.click(screen.getByRole("button", { name: "More for member 2" }));
  await user.click(await screen.findByRole("menuitem", { name: "Test in Chat" }));
  expect(openChat).toHaveBeenCalledExactlyOnceWith({ kind: "model", provider: "zeta", model: "qwen/m-2" });
});

test("an agent tests a member from its row menu", async () => {
  await renderTab();
  const run = await agent.act({ steps: [{ ref: "More for member 1", action: "press", args: ["Test in Chat"] }] });
  expect(run.ok, run.error?.message).toBe(true);
  expect(openChat).toHaveBeenCalledExactlyOnceWith({ kind: "model", provider: "acme", model: "m-1" });
});
