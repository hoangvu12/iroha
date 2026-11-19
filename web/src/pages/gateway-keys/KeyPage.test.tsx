import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createAgent } from "@ui-sdk/react/agent";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, expect, test, vi } from "vitest";
import { ChatPanelProvider } from "@/app/chat-panel";
import { Toaster } from "@/ui/toast";
import type { GatewayKey } from "./api";
import { KeyPage } from "./KeyPage";

// The Gateway Key page saves inline: a rename and the capture switch show
// their result where they were changed, never in a toast (UI ticket 04).

const agent = createAgent();

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const onPage = { ignore: "script, style, [data-ui-sdk-announcer]" };

function renderKey(patch: (body: Partial<GatewayKey>) => Response) {
  let key: GatewayKey = {
    id: "gk_1",
    name: "linh",
    secret: "iroha_gk_secret_1",
    scope: { all: true },
    capture: false,
    revoked: false,
    created_at: "2026-11-01T00:00:00Z",
    recent_requests: 0,
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    if (init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as Partial<GatewayKey>;
      const res = patch(body);
      if (res.ok) key = { ...key, ...body };
      return res;
    }
    if (url === "/api/gateway-keys/gk_1") return json(200, key);
    if (url === "/api/settings") return json(200, { settings: [] });
    return json(200, {});
  });
  vi.stubGlobal("fetch", fetch);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/gateway-keys/gk_1"]}>
        <ChatPanelProvider>
          <Routes>
            <Route path="/gateway-keys/:key" element={<KeyPage />} />
          </Routes>
        </ChatPanelProvider>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  );
  return fetch;
}

afterEach(() => vi.unstubAllGlobals());

const noToast = () => expect(document.querySelector("[data-slot=toast]")).toBeNull();

test("a rename shows its result and Undo beside the Name field, not in a toast", async () => {
  const user = userEvent.setup();
  renderKey(() => json(200, { audit_entry: "ae_1", changes: [] }));
  const name = await screen.findByRole("textbox", { name: "Name" });
  await user.clear(name);
  await user.type(name, "linh-2{Enter}");
  expect(await screen.findByText("Renamed to linh-2", onPage)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Undo: Renamed to linh-2" })).toBeTruthy();
  noToast();
});

test("a refused rename says why under the field and keeps what was typed", async () => {
  const user = userEvent.setup();
  renderKey(() => json(409, { error: { code: "name_taken", message: "A Gateway Key is already named huy.", hint: "Pick another name." } }));
  const name = await screen.findByRole("textbox", { name: "Name" });
  await user.clear(name);
  await user.type(name, "huy{Enter}");
  expect((await screen.findByRole("alert")).textContent).toBe("A Gateway Key is already named huy. Pick another name.");
  expect((name as HTMLInputElement).value).toBe("huy");
  expect(name.getAttribute("aria-invalid")).toBe("true");
  noToast();
});

test("the capture switch shows its new state at once and its result beside it", async () => {
  const user = userEvent.setup();
  const fetch = renderKey(() => json(200, { audit_entry: "ae_2", changes: [] }));
  const sw = await screen.findByRole("switch", { name: "Capture prompts and responses" });
  await user.click(sw);
  expect(sw.getAttribute("aria-checked")).toBe("true");
  expect(await screen.findByText("Capture on", onPage)).toBeTruthy();
  const [, init] = fetch.mock.calls.find(([, i]) => i?.method === "PATCH")!;
  expect(JSON.parse(String(init?.body))).toEqual({ capture: true });
  await waitFor(() => expect(sw.hasAttribute("aria-busy")).toBe(false));
  expect(sw.getAttribute("aria-checked")).toBe("true");
  // The switch undoes itself: no Undo beside it.
  expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
  noToast();
});

test("an agent finds the page's controls by name, renames the key and copies it", async () => {
  renderKey(() => json(200, { audit_entry: "ae_3", changes: [] }));
  await screen.findByRole("textbox", { name: "Name" });
  const components = agent.snapshot().filter((e) => !e.offPage && e.component !== "more");
  for (const entry of components) expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy();
  const labels = components.map((e) => e.label);
  for (const label of ["Name", "Copy the Gateway Key", "Copy the Base URL", "Capture prompts and responses"]) expect(labels).toContain(label);

  userEvent.setup(); // its clipboard stub
  const result = await agent.act({ steps: [{ ref: "Copy the Gateway Key", action: "press" }] });
  expect(result.ok, result.error?.message).toBe(true);
  expect(await navigator.clipboard.readText()).toBe("iroha_gk_secret_1");
  await waitFor(() => expect(screen.getByRole("button", { name: "Copy the Gateway Key" }).textContent).toBe("Copied"));
  noToast();
});
