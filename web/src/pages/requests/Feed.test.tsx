import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test, vi } from "vitest";
import { SheetStackProvider } from "@/sheets/stack";
import type { RequestRecord } from "./api";
import { RequestsFeed } from "./Feed";

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

function request(id: string, status: number): RequestRecord {
  return {
    id,
    started_at: new Date().toISOString(),
    state: "completed",
    status,
    caller: { kind: "gateway_key", name: "linh" },
    route: "/v1/chat/completions",
    shape_in: "openai-chat",
    model: "qwen3-max",
    stream: false,
    provider: "dashscope",
    attempt_count: 1,
    captured: false,
  };
}

test("changing a filter keeps the rows on screen until the new ones arrive, with no skeleton", async () => {
  let release!: (r: Response) => void;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = new URL(String(input), "http://iroha.test");
    if (url.pathname === "/api/requests" && !url.searchParams.has("changed_after")) {
      if (url.searchParams.get("status") === "failed") return json({ requests: [request("req_failed", 502)], cursor: 1 });
      return new Promise<Response>((resolve) => (release = resolve));
    }
    if (url.pathname === "/api/requests/stats") return json({ requests: 1, in_progress: 0, succeeded: 0, failed: 1, retried: 0, tokens: { input: 0, output: 0, cache_read: 0, reasoning: 0, total: 0 } });
    if (url.pathname === "/api/requests/filters") return json({ callers: [], providers: [], pools: [], models: [] });
    return json({});
  });
  vi.stubGlobal("fetch", fetch);
  const user = userEvent.setup();
  const { container } = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/requests?status=failed"]}>
        <SheetStackProvider>
          <RequestsFeed />
        </SheetStackProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  await screen.findByRole("row", { name: "Request req_failed" });
  await user.click(screen.getByRole("button", { name: "Remove filter" }));
  await waitFor(() => expect(release).toBeTypeOf("function"));

  expect(screen.getByRole("row", { name: "Request req_failed" })).toBeTruthy();
  expect(container.querySelector("[aria-busy=true]")).toBeNull();

  release(json({ requests: [request("req_ok", 200)], cursor: 2 }));
  await screen.findByRole("row", { name: "Request req_ok" });
  expect(screen.queryByRole("row", { name: "Request req_failed" })).toBeNull();
});

test("the first load shows a skeleton of the feed, labelled for screen readers", async () => {
  vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>(() => new Promise<Response>(() => {})));
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={["/requests"]}>
        <SheetStackProvider>
          <RequestsFeed />
        </SheetStackProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(screen.getByText("Loading Requests")).toBeTruthy();
  expect(screen.queryAllByRole("row")).toHaveLength(0);
});
