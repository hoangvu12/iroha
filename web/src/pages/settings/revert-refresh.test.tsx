import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test, vi } from "vitest";
import type { AuditEntry } from "@/api/types";
import { AuditEntriesTab } from "./AuditEntries";

// UI ticket 32: a Revert on Audit Entries can change any record (a key, a
// Provider, a Gateway Key), so what other pages and open sheets keep of
// configuration is refreshed; the Requests feed (history, not
// configuration) is left alone.

const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

const ENTRY: AuditEntry = {
  id: "ae_1",
  time: new Date().toISOString(),
  actor: { kind: "owner_session", id: "os_1", name: "Owner" },
  action: "update",
  summary: "Upstream Key acme/team-1 disabled",
  revertible: true,
  changes: [{ resource: "upstream_key", id: "key_1", name: "acme/team-1", op: "update", fields: ["enabled"], before: { enabled: true }, after: { enabled: false } }],
};

afterEach(() => vi.unstubAllGlobals());

test("a Revert refreshes the configuration other pages and sheets keep, not the Requests feed", async () => {
  const user = userEvent.setup();
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof globalThis.fetch>(async (u, init) => {
      const at = new URL(String(u), "http://iroha");
      if (init?.method === "POST") return answer({ audit_entry: "ae_2", changes: [], reverted: "ae_1" });
      if (at.pathname === "/api/audit-entries/filters") return answer({ actors: [], resources: [] });
      return answer({ entries: [ENTRY] });
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  // What other pages and sheets read before, still cached.
  const kept = {
    keys: ["providers", "acme", "keys"],
    keySheet: ["providers", "acme", "keys", "one", "team-1"],
    pools: ["pools"],
    gatewayKeys: ["gateway-keys", "list"],
    sendAs: ["providers-page", "gateway-keys"],
    chatModels: ["test-models", "", "", ""],
  };
  for (const k of Object.values(kept)) qc.setQueryData(k, []);
  qc.setQueryData(["requests", "list", {}], { pages: [], pageParams: [] });

  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/settings/audit-entries"]}>
        <AuditEntriesTab />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await user.click(await screen.findByRole("button", { name: "Revert Upstream Key acme/team-1 disabled" }));

  await waitFor(() => {
    for (const [name, k] of Object.entries(kept)) expect(qc.getQueryState(k)?.isInvalidated, name).toBe(true);
  });
  expect(qc.getQueryState(["requests", "list", {}])?.isInvalidated).toBe(false);
});
