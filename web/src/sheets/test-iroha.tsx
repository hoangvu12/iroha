import type { ReactNode } from "react";
import { configure, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { vi } from "vitest";
import { ChatPanelProvider } from "@/app/chat-panel";
import { SheetStack } from "./SheetStack";
import { SheetStackProvider } from "./stack";

// Sheet bodies load lazily and slide out before they unmount: on a busy run that takes longer than 1 s.
configure({ asyncUtilTimeout: 4000 });

// A fake Iroha for sheet tests: one Provider (acme) with an Endpoint and two
// keys, a Gateway Key, a Pool and a Request served through them.

const at = "2026-11-19T10:00:00Z";
const endpoint = {
  id: "e1",
  provider: "acme",
  name: "main",
  url: "https://api.acme.test/v1",
  shape: "openai-chat",
  auth_style: "bearer",
  static_headers: {},
  renames: {},
  discovery_url: "",
  created_at: at,
};
const provider = {
  id: "p1",
  handle: "acme",
  name: "Acme AI",
  enabled: true,
  archived: false,
  caller_path: "/providers/acme/v1",
  created_at: at,
  budget: { max_attempts: 3, first_byte_seconds: 30, overridden: false },
  strict: false,
  discovery: "provider",
  models_dev_brand: "",
  logo_domain: "",
  logo_domain_guessed: true,
  endpoints: [endpoint],
  upstream_key_count: 2,
};
const key = (name: string, state: object, enabled = true) => ({
  id: "k-" + name,
  provider: "acme",
  name,
  secret: "sk-abcdef" + name,
  enabled,
  state,
  cooling_models: [],
  model_gaps: [],
  endpoints: [],
  endpoint_gaps: [],
  worked_on: [],
  created_at: at,
});
const keys = [key("team-5", { state: "cooling", reason: "429 Too Many Requests", until: "2099-01-01T00:00:00Z", request_id: "req_0" }), key("team-6", { state: "active" })];
const summary = {
  keys: { total: 2, active: 1, disabled: 0, invalid: 0, cooling: 1, keyless: 0 },
  recent_attempts: { since: at, attempts: 40, failed: 2, failure_rate: 0.05 },
};
const request = {
  id: "req_1",
  started_at: at,
  state: "completed",
  status: 200,
  caller: { kind: "gateway_key", gateway_key_id: "gk_1", name: "zeron" },
  route: "/v1/chat/completions",
  shape_in: "openai-chat",
  shape_out: "openai-chat",
  model: "fast",
  pool: "fast",
  stream: false,
  provider: "acme",
  endpoint: "main",
  upstream_key: "team-5",
  attempt_count: 1,
  captured: false,
  attempts: [],
};
const gatewayKey = {
  id: "gk_1",
  name: "zeron",
  secret: "iroha_gk_secret1234",
  scope: { all: false, providers: [{ provider: "acme" }], pools: ["fast"] },
  capture: false,
  revoked: false,
  created_at: at,
  recent_requests: 12,
};
const pool = {
  id: "pl1",
  name: "fast",
  maker: "openai",
  maker_guessed: false,
  members: [{ position: 1, provider: "acme", model: "gpt-fast", enabled: true }],
  budget: { max_attempts: 4, first_byte_seconds: 20 },
  created_at: at,
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export const routes: Record<string, unknown> = {
  "GET /api/providers/acme": provider,
  "GET /api/providers/acme/summary": summary,
  "GET /api/providers/acme/keys": { upstream_keys: keys },
  "GET /api/providers/acme/keys/team-5": keys[0],
  "GET /api/providers/acme/keys/team-6": keys[1],
  "GET /api/providers/acme/endpoints/main": endpoint,
  "GET /api/requests/req_1": request,
  "GET /api/gateway-keys/gk_1": gatewayKey,
  "GET /api/pools/fast": pool,
};

export function fakeIroha() {
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).split("?")[0];
    const body = routes[`${init?.method ?? "GET"} ${path}`];
    if (body === undefined) return json(404, { error: { code: "not_found", message: `No ${path}` } });
    return json(200, body);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/**
 * The sheet named `name` once its body has loaded. While a body's chunk
 * loads, the stack shows a fallback with its own bar and the same name, and
 * the body's bar (the one with "Open page") replaces it: a button found in
 * the fallback can be gone by the time a click reaches it (busy runs).
 */
export async function loadedSheet(name: string): Promise<HTMLElement> {
  const sheet = await screen.findByRole("dialog", { name });
  await within(sheet).findByRole("link", { name: "Open page" });
  return sheet;
}

/** The URL the router is at, for assertions. */
export function Where() {
  const l = useLocation();
  return <output aria-label="Location">{decodeURIComponent(l.pathname + l.search)}</output>;
}

/** Renders `page` at `url` with the sheet stack, the chat panel slot and a fake Iroha. */
export function renderWithSheets(page: ReactNode, url = "/page") {
  const fetch = fakeIroha();
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: (
          <ChatPanelProvider>
            <SheetStackProvider>
              {page}
              <Where />
              <SheetStack />
            </SheetStackProvider>
          </ChatPanelProvider>
        ),
      },
    ],
    { initialEntries: [url] },
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, fetch };
}
