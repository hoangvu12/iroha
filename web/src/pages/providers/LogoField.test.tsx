import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createAgent } from "@ui-sdk/react/agent";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test, vi } from "vitest";
import type { Pool, Provider } from "./api";
import { PoolSettingsTab } from "./PoolSettings";
import { ProviderSettingsTab } from "./ProviderSettings";

const agent = createAgent();

const pool: Pool = {
  id: "pl_1",
  name: "gpt-6.1-sol",
  maker: "openai",
  maker_guessed: true,
  members: [],
  budget: { max_attempts: 0, first_byte_seconds: 0 },
  created_at: "2026-11-19T00:00:00Z",
};

const provider = {
  id: "pr_1",
  handle: "dashscope",
  name: "DashScope",
  enabled: true,
  archived: false,
  logo_domain: "aliyuncs.com",
  logo_domain_guessed: true,
  caller_path: "/providers/dashscope/v1",
  upstream_key_count: 0,
  endpoints: [],
} as unknown as Provider;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
const image = () => new Response("<svg/>", { status: 200, headers: { "Content-Type": "image/svg+xml" } });
const noLogo = () => json(404, { error: { code: "logo_unavailable", message: "No logo was found.", hint: "" } });

/** Answers logo lookups from `logos` (url -> answer) and records every call. */
function renderWith(page: React.ReactNode, logos: Record<string, () => Response>) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    if (url.startsWith("/api/logos")) return (logos[url] ?? noLogo)();
    if (init?.method === "PATCH") return json(200, { audit_entry: "ae_1", pool, provider });
    return json(200, {});
  });
  vi.stubGlobal("fetch", fetch);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{page}</MemoryRouter>
    </QueryClientProvider>,
  );
  return fetch;
}

afterEach(() => vi.unstubAllGlobals());

const logoCalls = (fetch: ReturnType<typeof renderWith>) => fetch.mock.calls.map(([u]) => String(u)).filter((u) => u.startsWith("/api/logos"));

test("an agent sets a Pool's logo to a website, sees none was found before saving, and saves it", async () => {
  const fetch = renderWith(<PoolSettingsTab pool={pool} />, { "/api/logos?maker=openai": image });

  const components = agent.snapshot().filter((e) => !e.offPage && e.component !== "more");
  for (const entry of components) expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy();
  expect(components.map((e) => e.label)).toContain("Maker or website");

  // The guessed maker is checked at once.
  expect(await screen.findByText("Logo found for openai.")).toBeTruthy();

  const typed = await agent.act({ steps: [{ ref: "Maker or website", action: "setValue", args: ["chatgpt.com"] }] });
  expect(typed.ok, typed.error?.message).toBe(true);
  expect(await screen.findByText("No logo found for chatgpt.com. The tile shows a letter.", undefined, { timeout: 2000 })).toBeTruthy();
  expect(logoCalls(fetch)).toEqual(["/api/logos?maker=openai", "/api/logos?maker=chatgpt.com"]);
  expect(fetch.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);

  const saved = await agent.act({ steps: [{ ref: "Save", action: "press" }] });
  expect(saved.ok, saved.error?.message).toBe(true);
  await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
  const [url, init] = fetch.mock.calls.find(([, i]) => i?.method === "PATCH")!;
  expect(url).toBe("/api/pools/gpt-6.1-sol");
  expect(JSON.parse(String(init?.body))).toEqual({ maker: "chatgpt.com" });
});

test("the Pool logo field previews what it finds as you type, debounced, and is described by the result", async () => {
  const user = userEvent.setup();
  const fetch = renderWith(<PoolSettingsTab pool={pool} />, { "/api/logos?maker=openai": image, "/api/logos?maker=chatgpt.com": image });
  const input = screen.getByLabelText<HTMLInputElement>("Maker or website", { selector: "input" });
  await screen.findByText("Logo found for openai.");
  await user.clear(input);
  await user.type(input, "chatgpt.com");
  // One lookup for the whole word, not one per key.
  expect(await screen.findByText("Logo found for chatgpt.com.", undefined, { timeout: 2000 })).toBeTruthy();
  expect(logoCalls(fetch)).toEqual(["/api/logos?maker=openai", "/api/logos?maker=chatgpt.com"]);
  const status = screen.getByRole("status");
  expect(input.getAttribute("aria-describedby")?.split(" ")).toContain(status.id);
  expect(document.querySelector("img")?.getAttribute("src")).toBe("/api/logos?maker=chatgpt.com");
});

test("a value Iroha refuses is said inline and marks the field invalid", async () => {
  const user = userEvent.setup();
  renderWith(<PoolSettingsTab pool={pool} />, {
    "/api/logos?maker=10.0.0.1": () => json(400, { error: { code: "bad_request", message: '"10.0.0.1" is not a website\'s domain.', hint: "Use a website such as chatgpt.com." } }),
  });
  const input = screen.getByLabelText<HTMLInputElement>("Maker or website", { selector: "input" });
  await user.type(input, "10.0.0.1");
  expect(await screen.findByText('"10.0.0.1" is not a website\'s domain. Use a website such as chatgpt.com.', undefined, { timeout: 2000 })).toBeTruthy();
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(document.querySelector("img")).toBeNull();
});

test("the Provider logo field reports the same way", async () => {
  const user = userEvent.setup();
  const fetch = renderWith(<ProviderSettingsTab provider={provider} />, { "/api/logos?domain=aliyuncs.com": image });
  expect(await screen.findByText("Logo found for aliyuncs.com.")).toBeTruthy();
  const input = screen.getByLabelText<HTMLInputElement>("Logo domain", { selector: "input" });
  await user.type(input, "example.org");
  expect(await screen.findByText("No logo found for example.org. The tile shows a letter.", undefined, { timeout: 2000 })).toBeTruthy();
  expect(logoCalls(fetch)).toEqual(["/api/logos?domain=aliyuncs.com", "/api/logos?domain=example.org"]);
  // "none" asks for the letter: nothing to look up.
  await user.clear(input);
  await user.type(input, "none");
  expect(await screen.findByText("Shows the first letter.", undefined, { timeout: 2000 })).toBeTruthy();
  expect(logoCalls(fetch)).toHaveLength(2);
});
