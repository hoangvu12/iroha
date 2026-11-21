import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createAgent } from "@ui-sdk/react/agent";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test, vi } from "vitest";
import { SheetStackProvider } from "@/sheets/stack";
import type { RequestRecord } from "./api";
import { type FeedPaging, RequestsFeed } from "./Feed";

const agent = createAgent();

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const STATS = { requests: 1, in_progress: 0, succeeded: 0, failed: 1, retried: 0, tokens: { input: 0, output: 0, cache_read: 0, reasoning: 0, total: 0 } };

function request(id: string, status = 200, startedAt = new Date().toISOString()): RequestRecord {
  return {
    id,
    started_at: startedAt,
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

function iroha(list: (p: URLSearchParams) => unknown | Promise<Response>, stats: unknown = STATS, filters: unknown = { callers: [], providers: [], pools: [], models: [] }) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = new URL(String(input), "http://iroha.test");
    if (url.pathname === "/api/requests") {
      const body = await list(url.searchParams);
      return body instanceof Response ? body : json(body);
    }
    if (url.pathname === "/api/requests/stats") return json(stats);
    if (url.pathname === "/api/requests/filters") return json(filters);
    return json({});
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/** The end of the list is always in view (a real observer reports it as soon as it observes). */
function endInView() {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      cb: (e: { isIntersecting: boolean }[]) => void;
      constructor(cb: (e: { isIntersecting: boolean }[]) => void) {
        this.cb = cb;
      }
      observe() {
        this.cb([{ isIntersecting: true }]);
      }
      disconnect() {}
    },
  );
}

function renderFeed(url = "/requests", paging?: FeedPaging) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[url]}>
        <SheetStackProvider>
          <RequestsFeed paging={paging} />
        </SheetStackProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const opener = (id: string) => screen.queryByRole("button", { name: `Open Request ${id}` });
const shownIds = () =>
  within(screen.getByRole("table", { name: "Requests" }))
    .getAllByRole("row")
    .slice(1)
    .map((r) => r.getAttribute("data-row-id"));
const listCalls = (fetch: ReturnType<typeof iroha>) =>
  fetch.mock.calls.map(([u]) => new URL(String(u), "http://iroha.test")).filter((u) => u.pathname === "/api/requests" && !u.searchParams.has("changed_after"));

test("changing a filter keeps the rows on screen until the new ones arrive, with no skeleton", async () => {
  let release!: (r: Response) => void;
  iroha((p) => {
    if (p.has("changed_after")) return { requests: [], cursor: 1 };
    if (p.get("status") === "failed") return { requests: [request("req_failed", 502)], cursor: 1 };
    return new Promise<Response>((resolve) => (release = resolve));
  });
  const user = userEvent.setup();
  const { container } = renderFeed("/requests?status=failed");

  await waitFor(() => expect(opener("req_failed")).toBeTruthy());
  await user.click(screen.getByRole("button", { name: "Remove filter Status is Failed" }));
  await waitFor(() => expect(release).toBeTypeOf("function"));

  expect(opener("req_failed")).toBeTruthy();
  expect(container.querySelector("[aria-busy=true]")).toBeNull();

  release(json({ requests: [request("req_ok", 200)], cursor: 2 }));
  await waitFor(() => expect(opener("req_ok")).toBeTruthy());
  expect(opener("req_failed")).toBeNull();
});

test("a Gateway Key's ID as the caller (its Requests count links so) filters by the ID and reads as the key's name", async () => {
  const callers = [
    { name: "linh", kind: "gateway_key", gateway_key_id: "gk_1", requests: 30 },
    { name: "caller-2", kind: "gateway_key", gateway_key_id: "gk_2", requests: 20 },
  ];
  const fetch = iroha(() => ({ requests: [request("req_1")], cursor: 1 }), STATS, { callers, providers: [], pools: [], models: [] });
  const user = userEvent.setup();
  renderFeed("/requests?caller=gk_2&range=24h");

  expect(await screen.findByRole("button", { name: "Remove filter Caller is caller-2" })).toBeTruthy();
  expect(listCalls(fetch)[0].searchParams.get("caller")).toBe("gk_2");

  await user.click(screen.getByRole("button", { name: /Filter/ }));
  await user.click(await screen.findByRole("menuitem", { name: /Caller/ }));
  expect((await screen.findByRole("menuitemradio", { name: /caller-2/ })).getAttribute("aria-checked")).toBe("true");
  expect(screen.queryByRole("menuitemradio", { name: /gk_2/ })).toBeNull();
});

async function cachedFigure() {
  const term = await waitFor(() => {
    const t = screen.getByText("Cached");
    expect(t.closest("[inert]")).toBeNull();
    return t;
  });
  expect(term.tagName).toBe("DT");
  return term.nextElementSibling as HTMLElement;
}

test("the stats row shows the cached share: cache read over input", async () => {
  const tokens = { input: 4000, output: 100, cache_read: 1000, cache_write: 600, cache_write_long: 0, reasoning: 0, total: 4100 };
  iroha(() => ({ requests: [request("req_1")], cursor: 1 }), { ...STATS, cache_hits: 1, tokens });
  renderFeed();
  const figure = await cachedFigure();
  expect(figure.textContent).toBe("25.0%");
  expect(figure.getAttribute("title")).toBe("1,000 of 4,000 input tokens read from the cache; 600 written to it");
});

test("the cached share is a dash while no input was counted", async () => {
  iroha(() => ({ requests: [request("req_1")], cursor: 1 }));
  renderFeed();
  expect((await cachedFigure()).textContent).toBe("–");
});

test("the first load shows a skeleton of the feed, labelled for screen readers", async () => {
  vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>(() => new Promise<Response>(() => {})));
  renderFeed();
  expect(screen.getByText("Loading Requests")).toBeTruthy();
  expect(screen.queryAllByRole("row")).toHaveLength(0);
});

test("scrolling to the end loads older Requests with the API's next_before, until there are none", async () => {
  endInView();
  const fetch = iroha((p) => {
    if (p.has("changed_after")) return { requests: [], cursor: 1 };
    if (p.get("before") === "req_2") return { requests: [request("req_3")], next_before: "req_3", cursor: 1 };
    if (p.get("before") === "req_3") return { requests: [request("req_4")], cursor: 1 };
    return { requests: [request("req_1"), request("req_2")], next_before: "req_2", cursor: 1 };
  });
  renderFeed();
  await waitFor(() => expect(shownIds()).toEqual(["req_1", "req_2", "req_3", "req_4"]));
  expect(listCalls(fetch).map((u) => u.searchParams.get("before"))).toEqual([null, "req_2", "req_3"]);
  expect(screen.queryByRole("button", { name: "Load older Requests" })).toBeNull();
});

test("Load older Requests is there for the keyboard while there are older ones", async () => {
  iroha((p) => {
    if (p.has("changed_after")) return { requests: [], cursor: 1 };
    if (p.get("before") === "req_1") return { requests: [request("req_2")], cursor: 1 };
    return { requests: [request("req_1")], next_before: "req_1", cursor: 1 };
  });
  const user = userEvent.setup();
  renderFeed();
  await user.click(await screen.findByRole("button", { name: "Load older Requests" }));
  await waitFor(() => expect(shownIds()).toEqual(["req_1", "req_2"]));
  expect(screen.queryByRole("button", { name: "Load older Requests" })).toBeNull();
});

test("new Requests arrive live on top of the feed", async () => {
  const older = new Date(Date.now() - 60_000).toISOString();
  let polls = 0;
  iroha((p) => {
    if (p.has("changed_after")) return polls++ === 0 ? { requests: [request("req_new")], cursor: 2 } : { requests: [], cursor: 2 };
    return { requests: [request("req_old", 200, older)], cursor: 1 };
  });
  renderFeed();
  await waitFor(() => expect(shownIds()).toEqual(["req_old"]));
  await waitFor(() => expect(shownIds()).toEqual(["req_new", "req_old"]), { timeout: 4000 });
});

test("filters, the time range and the open Request come back from the URL after a reload", async () => {
  const fetch = iroha((p) => (p.has("changed_after") ? { requests: [], cursor: 1 } : { requests: [request("req_1", 502), request("req_2", 500)], cursor: 1 }));
  renderFeed("/requests?status=failed&range=24h&sheet=request:req_2");
  await waitFor(() => expect(opener("req_2")).toBeTruthy());
  const list = listCalls(fetch)[0].searchParams;
  expect(list.get("status")).toBe("failed");
  expect(list.get("since")).toBe("24h");
  expect(screen.getByText("Status is Failed")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Time: Last 24 hours" })).toBeTruthy();
  expect(opener("req_2")!.closest("tr")!.getAttribute("aria-current")).toBe("true");
  expect(opener("req_1")!.closest("tr")!.getAttribute("aria-current")).toBeNull();
});

test("numbered pages, if the Owner prefers them: a later page loads the older Requests it needs", async () => {
  const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => request(`req_${String(from + i).padStart(3, "0")}`));
  const fetch = iroha(
    (p) => {
      if (p.has("changed_after")) return { requests: [], cursor: 1 };
      if (p.get("before") === "req_100") return { requests: page(101, 20), cursor: 1 };
      return { requests: page(1, 100), next_before: "req_100", cursor: 1 };
    },
    { ...STATS, requests: 120 },
  );
  const user = userEvent.setup();
  renderFeed("/requests", "pages");
  await waitFor(() => expect(shownIds()).toHaveLength(25));
  expect(listCalls(fetch)).toHaveLength(1);
  const pages = screen.getByRole("navigation", { name: "Pages of Requests" });
  await user.click(within(pages).getByRole("button", { name: "Page 5" }));
  await waitFor(() => expect(shownIds()[0]).toBe("req_101"));
  expect(shownIds()).toHaveLength(20);
  expect(listCalls(fetch).map((u) => u.searchParams.get("before"))).toEqual([null, "req_100"]);
});

test("the Owner switches the feed to numbered pages in the View menu, and this browser remembers it", async () => {
  const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => request(`req_${String(from + i).padStart(3, "0")}`));
  iroha(
    (p) => {
      if (p.has("changed_after")) return { requests: [], cursor: 1 };
      return { requests: page(1, 30), cursor: 1 };
    },
    { ...STATS, requests: 30 },
  );
  const user = userEvent.setup();
  const first = renderFeed();
  await waitFor(() => expect(shownIds()).toHaveLength(30));
  expect(screen.queryByRole("navigation", { name: "Pages of Requests" })).toBeNull();

  await user.click(screen.getByRole("button", { name: "View" }));
  const choice = await screen.findByRole("menuitemradio", { name: "Numbered pages" });
  expect(screen.getByRole("menuitemradio", { name: "Live, load older as you scroll" }).getAttribute("aria-checked")).toBe("true");
  await user.click(choice);
  await waitFor(() => expect(shownIds()).toHaveLength(25));
  expect(within(screen.getByRole("navigation", { name: "Pages of Requests" })).getByRole("button", { name: "Page 2" })).toBeTruthy();
  expect(localStorage.getItem("iroha:requests:paging")).toBe("pages");

  first.unmount();
  renderFeed();
  await waitFor(() => expect(shownIds()).toHaveLength(25));
  expect(screen.getByRole("navigation", { name: "Pages of Requests" })).toBeTruthy();
});

test("an agent finds the feed's controls by name, opens a Request and loads older ones", async () => {
  iroha((p) => {
    if (p.has("changed_after")) return { requests: [], cursor: 1 };
    if (p.get("before") === "req_1") return { requests: [request("req_2")], cursor: 1 };
    return { requests: [request("req_1")], next_before: "req_1", cursor: 1 };
  });
  renderFeed();
  await screen.findByRole("button", { name: "Load older Requests" });
  const entries = agent.snapshot().filter((e) => !e.offPage && e.component !== "more");
  for (const e of entries) expect(e.label, `${e.component} ${e.ref} has no name`).toBeTruthy();
  const labels = entries.map((e) => e.label);
  for (const l of ["Search Requests", "Open Request req_1", "Load older Requests", "Requests", "Live"]) expect(labels, `${l} is missing`).toContain(l);

  const more = await agent.act({ steps: [{ ref: "Load older Requests", action: "press" }] });
  expect(more.ok, more.error?.message).toBe(true);
  await waitFor(() => expect(shownIds()).toEqual(["req_1", "req_2"]));
  const open = await agent.act({ steps: [{ ref: "Open Request req_2", action: "press" }] });
  expect(open.ok, open.error?.message).toBe(true);
  await waitFor(() => expect(opener("req_2")!.closest("tr")!.getAttribute("aria-current")).toBe("true"));
});
