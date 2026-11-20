import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createAgent } from "@ui-sdk/react/agent";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test, vi } from "vitest";
import { Toaster } from "@/ui/toast";
import type { Provider } from "./api";
import { ProviderSettingsTab } from "./ProviderSettings";
import { SAMPLE_PROVIDERS } from "./samples";

const agent = createAgent();
const provider: Provider = { ...SAMPLE_PROVIDERS[0], handle: "relay", affinity: "on" };

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => vi.unstubAllGlobals());

test("an agent turns conversation affinity off for a Provider", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) =>
    init?.method === "PATCH" ? json(200, { audit_entry: "ae_1", provider: { ...provider, affinity: "off" } }) : json(404, { error: { code: "not_found", message: "", hint: "" } }),
  );
  vi.stubGlobal("fetch", fetch);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ProviderSettingsTab provider={provider} />
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  );

  const toggle = screen.getByRole("switch", { name: "Keep each conversation on one key" });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(screen.getByText(/so the Provider's prompt cache stays warm/)).toBeTruthy();

  const done = await agent.act({ steps: [{ ref: "Keep each conversation on one key", action: "setChecked", args: [false] }] });
  expect(done.ok, done.error?.message).toBe(true);
  await waitFor(() => expect(fetch.mock.calls.some(([, i]) => i?.method === "PATCH")).toBe(true));
  const [url, init] = fetch.mock.calls.find(([, i]) => i?.method === "PATCH")!;
  expect(url).toBe("/api/providers/relay");
  expect(JSON.parse(String(init?.body))).toEqual({ affinity: "off" });
  expect(await screen.findByText("Keys used in turn")).toBeTruthy();
});

test("a Provider with affinity off shows the switch off", () => {
  vi.stubGlobal("fetch", vi.fn(async () => json(404, {})));
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ProviderSettingsTab provider={{ ...provider, affinity: "off" }} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(screen.getByRole("switch", { name: "Keep each conversation on one key" }).getAttribute("aria-checked")).toBe("false");
});
