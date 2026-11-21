import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Reply } from "./Reply";
import type { AssistantTurn } from "./store";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = new URL(url, "http://iroha.test");
      if (u.pathname === "/api/requests/req_1")
        return json({ id: "req_1", state: "done", upstream_key: "team-5", endpoint: "main", attempt_count: 1, first_byte_ms: 300, duration_ms: 900, usage: { input: 12, output: 34 } });
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  Element.prototype.getAnimations = () => [];
});

const done: AssistantTurn = {
  id: "t1",
  role: "assistant",
  model: "openai/gpt-4o",
  shape: "openai-chat",
  rounds: [{ requestId: "req_1", status: "done", parts: [{ kind: "text", text: "Hello." }] }],
};

function renderReply(turn: AssistantTurn) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (t: AssistantTurn) => (
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <Reply turn={t} />
      </QueryClientProvider>
    </MemoryRouter>
  );
  const r = render(ui(turn));
  return { rerender: (t: AssistantTurn) => r.rerender(ui(t)) };
}

test("Details opens as a collapsible and keeps its facts on screen while it closes", async () => {
  const user = userEvent.setup();
  renderReply(done);
  const toggle = screen.getByRole("button", { name: "Details" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  await user.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  await screen.findByText("team-5");
  // Hold the exit open with a transition the test ends (jsdom has no real ones).
  let end = () => {};
  const finished = new Promise<void>((r) => (end = r));
  const running = { finished, effect: { getComputedTiming: () => ({ endTime: 60_000, localTime: 0 }) } } as unknown as Animation;
  Element.prototype.getAnimations = () => [running];
  await user.click(toggle);
  const panel = screen.getByText("team-5").closest("[data-slot='collapsible-panel']")!;
  expect(panel.hasAttribute("data-ending-style")).toBe(true);
  act(end);
  await waitFor(() => expect(screen.queryByText("team-5")).toBeNull());
});

test("pointing at Details fetches its facts, so the panel opens at its full height with nothing loading in mid-animation", async () => {
  const user = userEvent.setup();
  renderReply(done);
  const calls = () => vi.mocked(fetch).mock.calls.filter(([u]) => String(u).includes("/api/requests/req_1")).length;
  expect(calls()).toBe(0);
  await user.hover(screen.getByRole("button", { name: "Details" }));
  await waitFor(() => expect(calls()).toBe(1));
});

test("Thinking shows while it streams and folds behind its toggle afterwards", async () => {
  const user = userEvent.setup();
  const streaming: AssistantTurn = { ...done, rounds: [{ status: "streaming", parts: [{ kind: "reasoning", text: "Let me see." }] }] };
  const { rerender } = renderReply(streaming);
  expect(screen.getByText("Let me see.")).not.toBeNull();
  rerender({ ...done, rounds: [{ requestId: "req_1", status: "done", parts: [{ kind: "reasoning", text: "Let me see." }, { kind: "text", text: "Yes." }] }] });
  await waitFor(() => expect(screen.queryByText("Let me see.")).toBeNull());
  const toggle = screen.getByRole("button", { name: "Thinking" });
  await user.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("Let me see.")).not.toBeNull();
});

const failedRound = { requestId: "req_9", status: "failed" as const, parts: [], error: "No key could serve gpt-4o" };

test("a failure that arrives on screen enters from its starting style", () => {
  const { rerender } = renderReply({ ...done, rounds: [{ status: "streaming", parts: [] }] });
  rerender({ ...done, rounds: [failedRound] });
  const block = screen.getByText("No key could serve gpt-4o").closest("[data-failure]")!;
  expect(block.hasAttribute("data-starting-style")).toBe(true);
});

test("a failure already in the history is just there", () => {
  renderReply({ ...done, rounds: [failedRound] });
  const block = screen.getByText("No key could serve gpt-4o").closest("[data-failure]")!;
  expect(block.hasAttribute("data-starting-style")).toBe(false);
});
