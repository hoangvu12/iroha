import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useRequestFeed } from "./api";

// UI ticket 32: the live feed polls GET /api/requests?changed_after= every
// 2 s while the tab is shown, like every other poll in the UI stops while
// the tab is hidden, and catches up at once when the tab is shown again.

const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

let hidden = false;
const setHidden = (h: boolean) => {
  hidden = h;
  document.dispatchEvent(new Event("visibilitychange"));
};

beforeEach(() => {
  hidden = false;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => (hidden ? "hidden" : "visible"));
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("the live feed doesn't poll while the tab is hidden, and catches up as soon as it is shown", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (u) => {
    const at = new URL(String(u), "http://iroha");
    return answer({ requests: [], cursor: at.searchParams.has("changed_after") ? 6 : 5 });
  });
  vi.stubGlobal("fetch", fetch);
  const polls = () => fetch.mock.calls.filter(([u]) => String(u).includes("changed_after")).length;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  renderHook(() => useRequestFeed({}, true), { wrapper });

  // Shown: a poll every 2 s.
  await act(() => vi.advanceTimersByTimeAsync(4_100));
  expect(polls()).toBe(2);

  // Hidden for a minute: no poll.
  act(() => setHidden(true));
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  const whileHidden = polls();
  expect(whileHidden).toBeLessThanOrEqual(3); // at most the tick already due when it was hidden

  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(polls()).toBe(whileHidden);

  // Shown again: it catches up at once, then every 2 s.
  act(() => setHidden(false));
  await act(() => vi.advanceTimersByTimeAsync(10));
  expect(polls()).toBe(whileHidden + 1);
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  expect(polls()).toBe(whileHidden + 2);
});
