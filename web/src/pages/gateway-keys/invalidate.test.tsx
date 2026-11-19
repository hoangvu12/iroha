import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { expect, test } from "vitest";
import { useInvalidateKeys } from "./api";

// UI ticket 32: a Gateway Key change (or its Undo) also refreshes the other
// places that list Gateway Keys or depend on their scopes: the chat's "Send
// as" list and model choices, and a Pool's Members tab. Not Providers.

test("a Gateway Key change refreshes every list of Gateway Keys, and nothing about Providers", async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  const refreshed = {
    list: ["gateway-keys", "list"],
    page: ["gateway-keys", "one", "linh"],
    history: ["audit-entries", "list"],
    sendAs: ["providers-page", "gateway-keys"],
    chatModels: ["test-models", "", "linh", ""],
  };
  const untouched = { providers: ["providers"], keys: ["providers", "acme", "keys"], pools: ["pools"] };
  for (const k of [...Object.values(refreshed), ...Object.values(untouched)]) qc.setQueryData(k, []);

  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const { result } = renderHook(() => useInvalidateKeys(), { wrapper });
  await result.current();

  for (const [name, k] of Object.entries(refreshed)) expect(qc.getQueryState(k)?.isInvalidated, name).toBe(true);
  for (const [name, k] of Object.entries(untouched)) expect(qc.getQueryState(k)?.isInvalidated, name).toBe(false);
});
