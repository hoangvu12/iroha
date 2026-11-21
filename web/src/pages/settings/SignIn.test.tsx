import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createAgent } from "@ui-sdk/react/agent";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { OwnerSession } from "@/api/session";
import { Toaster } from "@/ui/toast";
import { SignInTab } from "./SignIn";

let approve = false;
const agent = createAgent({ allow: (step) => !step.confirm || approve });
const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

const UA = {
  chromeWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Safari/537.36",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
  safariPhone: "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile Safari/604.1",
};

const session = (id: string, ua: string, day: number, o: Partial<OwnerSession> = {}): OwnerSession => ({
  id,
  user_agent: ua,
  created_at: new Date(Date.UTC(2026, 10, day, 9)).toISOString(),
  expires_at: new Date(Date.UTC(2026, 11, day, 9)).toISOString(),
  last_seen_at: new Date(Date.UTC(2026, 10, day, 12)).toISOString(),
  active: true,
  current: false,
  ...o,
});

const SESSIONS = [session("os_1", UA.chromeWin, 18, { current: true }), session("os_2", UA.firefoxLinux, 3), session("os_3", UA.safariPhone, 10)];

function renderTab(sessions = SESSIONS) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (u, init) => {
    if (String(u).startsWith("/api/owner-sessions") && (init?.method ?? "GET") === "GET") return answer({ owner_sessions: sessions });
    return answer({ audit_entry: "ae_1", changes: [], succeeded: 2, failed: 0, items: [] });
  });
  vi.stubGlobal("fetch", fetch);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <SignInTab />
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  );
  return fetch;
}

const writes = (fetch: ReturnType<typeof renderTab>) =>
  fetch.mock.calls.filter(([, init]) => (init?.method ?? "GET") !== "GET").map(([u, init]) => `${init?.method} ${String(u)}`);
const rows = () => within(screen.getByRole("table", { name: "Signed-in browsers" })).getAllByRole("row").slice(1);

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  approve = false;
});

test("browsers come newest sign-in first and sort by Browser, Signed in, Last seen and Expires", async () => {
  const user = userEvent.setup();
  renderTab();
  await screen.findByRole("table", { name: "Signed-in browsers" });
  expect(rows().map((r) => within(r).getAllByRole("cell")[0].textContent)).toEqual(["Chrome on WindowsThis browser", "Safari on iPhone", "Firefox on Linux"]);
  await user.click(screen.getByRole("button", { name: "Sort by Browser" }));
  expect(within(rows()[0]).getByText("Chrome on Windows")).toBeTruthy();
  expect(within(rows()[1]).getByText("Firefox on Linux")).toBeTruthy();
  for (const h of ["Signed in", "Last seen", "Expires"]) expect(screen.getByRole("button", { name: `Sort by ${h}` })).toBeTruthy();
});

test("signing out another browser asks first, naming it, then signs it out", async () => {
  const user = userEvent.setup();
  const fetch = renderTab();
  const out = await screen.findByRole("button", { name: "Sign out Firefox on Linux…" });
  expect(out.hasAttribute("data-danger")).toBe(true);
  await user.click(out);
  const dialog = await screen.findByRole("alertdialog", { name: "Sign out Firefox on Linux?" });
  await user.click(within(dialog).getByRole("button", { name: "Sign it out" }));
  await waitFor(() => expect(writes(fetch)).toEqual(["POST /api/owner-sessions/os_2/revoke"]));
});

test("Sign out the other browsers… asks with the count, then signs them all out at once", async () => {
  const user = userEvent.setup();
  const fetch = renderTab();
  await user.click(await screen.findByRole("button", { name: "Sign out the other browsers…" }));
  const dialog = await screen.findByRole("alertdialog", { name: "Sign out 2 other browsers?" });
  await user.click(within(dialog).getByRole("button", { name: "Sign them out" }));
  await waitFor(() => expect(writes(fetch)).toEqual(["POST /api/owner-sessions/bulk/revoke"]));
  expect(JSON.parse(String(fetch.mock.calls.find(([, i]) => i?.method === "POST")?.[1]?.body))).toEqual({ items: ["os_3", "os_2"] });
});

test("an agent finds every Sign-in control by a name of its own, and needs a person to sign a browser out", async () => {
  const fetch = renderTab();
  await screen.findByRole("table", { name: "Signed-in browsers" });
  const entries = agent.snapshot().filter((e) => !e.offPage && e.component !== "more");
  for (const e of entries) expect(e.label, `${e.component} ${e.ref} has no name`).toBeTruthy();
  const labels = entries.map((e) => e.label ?? "");
  for (const l of ["Change password…", "Sign out this browser", "Sign out Firefox on Linux…", "Sign out Safari on iPhone…", "Sign out the other browsers…", "Sort by Browser"])
    expect(labels, `${l} is missing`).toContain(l);
  for (const a of labels) for (const b of labels) if (a !== b) expect(b.startsWith(a + " "), `"${a}" is part of "${b}"`).toBe(false);

  const out = { steps: [{ ref: "Sign out Firefox on Linux…", action: "press" }, { ref: "Sign out Firefox on Linux?", action: "press", args: ["Sign it out"] }] };
  expect((await agent.act(out)).ok).toBe(false);
  expect(writes(fetch)).toEqual([]);
});

test("the password dialog's fields and its button have names of their own", async () => {
  const user = userEvent.setup();
  renderTab();
  await user.click(await screen.findByRole("button", { name: "Change password…" }));
  const dialog = await screen.findByRole("dialog", { name: "Change the Owner password" });
  expect(within(dialog).getByLabelText("Current password")).toBeTruthy();
  expect(within(dialog).getByLabelText("New password")).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "Save the new password" })).toBeTruthy();
});
