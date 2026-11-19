import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { useSignOut } from "./session";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test("signing out forgets the skeleton shapes remembered in this browser", async () => {
  localStorage.setItem("skullet:shapes", JSON.stringify({ v: 1, shapes: { "providers-list": {} } }));
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 })));
  const qc = new QueryClient();
  const { result } = renderHook(() => useSignOut(), {
    wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
  });
  result.current.mutate();
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(localStorage.getItem("skullet:shapes")).toBeNull();
});
