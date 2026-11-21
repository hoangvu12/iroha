import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { expect, test } from "vitest";
import { useRefresh } from "./api";

test("a Providers page change refreshes the chat's model choices too, not the Requests feed", async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  const refreshed = {
    providers: ["providers"],
    keys: ["providers", "acme", "keys"],
    pools: ["pools"],
    gatewayKeys: ["gateway-keys", "list"],
    chatModels: ["test-models", "gpt", "", ""],
  };
  const untouched = { feed: ["requests", "list", {}] };
  for (const k of [...Object.values(refreshed), ...Object.values(untouched)]) qc.setQueryData(k, []);

  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const { result } = renderHook(() => useRefresh(), { wrapper });
  await result.current();

  for (const [name, k] of Object.entries(refreshed)) expect(qc.getQueryState(k)?.isInvalidated, name).toBe(true);
  for (const [name, k] of Object.entries(untouched)) expect(qc.getQueryState(k)?.isInvalidated, name).toBe(false);
});
