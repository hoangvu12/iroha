import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createAgent } from "@ui-sdk/react/agent";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Classification, Rule } from "./api";
import { RulesTab } from "./Rules";

const agent = createAgent();
const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

const rule = (name: string, o: Partial<Rule> = {}): Rule => ({
  name,
  enabled: true,
  source: "builtin",
  status: ["429"],
  outcome: "cooling_key_model",
  key_effect: "Cool 60 s for the model",
  request_effect: "Try next key",
  hits: 0,
  order: 0,
  ...o,
});

const RULES = [
  rule("quota-words", { source: "owner", provider: "acme", body: "quota", outcome: "cooling_key", key_effect: "Cool 15 min" }),
  rule("forbidden", { enabled: false, status: ["403"] }),
  rule("rate-limited"),
  rule("server-error", { status: ["5xx"], outcome: "retry_elsewhere", key_effect: "No change" }),
];

const decided = (o: Partial<Classification> = {}): Classification => ({
  dry_run: false,
  provider: "acme",
  endpoint: "main",
  failure: true,
  rule: "rate-limited",
  outcome: "cooling_key_model",
  status: 429,
  embedded: false,
  reason: "429 rate_limit_exceeded: Rate limit reached",
  key_effect: "Cool 30 s for the model",
  request_effect: "Try next key",
  cooling_seconds: 30,
  cooling_from: "response",
  ...o,
});

function renderTab(result: Classification = decided()) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (u) => {
    const url = String(u);
    if (url.endsWith("/rules/classify")) return answer(result);
    if (url.startsWith("/api/rules")) return answer({ rules: RULES });
    return answer({});
  });
  vi.stubGlobal("fetch", fetch);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/providers/acme/rules"]}>
        <RulesTab handle="acme" adding={false} setAdding={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return fetch;
}

const classifyCalls = (fetch: ReturnType<typeof renderTab>) =>
  fetch.mock.calls.filter(([u]) => String(u).endsWith("/rules/classify")).map(([u, init]) => ({ url: String(u), body: JSON.parse(String(init?.body)) }));
const steps = () => within(screen.getByRole("list", { name: "Failure Rules, in the order they're tried" })).getAllByRole("listitem");
const panel = () => screen.findByRole("region", { name: "Try a failure" });

beforeEach(() => localStorage.setItem("iroha:rules:view", "flow"));
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test("an example fills the failure in one click; Try asks the server what the rules decide", async () => {
  const user = userEvent.setup();
  const fetch = renderTab();
  const p = await panel();
  await user.click(within(p).getByRole("button", { name: "429 cooling" }));
  expect((within(p).getByRole("textbox", { name: "Status" }) as HTMLInputElement).value).toBe("429");
  expect((within(p).getByRole("textbox", { name: "Body" }) as HTMLTextAreaElement).value).toContain("rate_limit_exceeded");
  expect((within(p).getByRole("textbox", { name: "Headers" }) as HTMLTextAreaElement).value).toBe("Retry-After: 30");
  await user.click(within(p).getByRole("button", { name: "Try this failure" }));
  await waitFor(() => expect(classifyCalls(fetch)).toHaveLength(1));
  const [call] = classifyCalls(fetch);
  expect(call.url).toBe("/api/providers/acme/rules/classify");
  expect(call.body.status).toBe(429);
  expect(call.body.headers).toEqual({ "Retry-After": "30" });
  expect(call.body.body).toContain("rate_limit_exceeded");
});

test("the result is said in words and the path lights up to the rule that matched", async () => {
  const user = userEvent.setup();
  renderTab();
  const p = await panel();
  await user.click(within(p).getByRole("button", { name: "429 cooling" }));
  await user.click(within(p).getByRole("button", { name: "Try this failure" }));
  const said = await within(p).findByRole("status");
  expect(said.textContent).toContain("Rule 3, rate-limited, matches. Upstream Key: Cool 30 s for the model (the time the response names). Request: Try next key.");
  expect(said.textContent).toContain("429 rate_limit_exceeded: Rate limit reached");
  const [owner, off, rate, server] = steps();
  expect(within(owner).getByText("Didn't match")).toBeTruthy();
  expect(within(off).queryByText("Didn't match")).toBeNull();
  expect(within(off).getByText("Off, skipped")).toBeTruthy();
  expect(rate.getAttribute("aria-current")).toBe("step");
  expect(within(rate).getByText("Matched")).toBeTruthy();
  expect(rate.textContent).toContain("Cool 30 s for the model");
  expect(server.getAttribute("data-trace")).toBe("unreached");
  expect(screen.getByRole("group", { name: "No rule matched" }).getAttribute("data-trace")).toBe("unreached");
});

test("no match lights the End card with the engine's fallback", async () => {
  const user = userEvent.setup();
  renderTab(decided({ rule: undefined, outcome: "fail_request", status: 418, reason: "418: I'm a teapot", key_effect: "No change", request_effect: "Return to Caller", cooling_seconds: undefined, cooling_from: undefined }));
  const p = await panel();
  await user.clear(within(p).getByRole("textbox", { name: "Status" }));
  await user.type(within(p).getByRole("textbox", { name: "Status" }), "418");
  await user.click(within(p).getByRole("button", { name: "Try this failure" }));
  const said = await within(p).findByRole("status");
  expect(said.textContent).toContain("No rule matches, so the fallback decides. Upstream Key: No change. Request: Return to Caller.");
  const end = screen.getByRole("group", { name: "No rule matched" });
  expect(end.getAttribute("aria-current")).toBe("step");
  for (const s of steps().filter((s) => !s.textContent?.includes("Off, skipped"))) expect(within(s).getByText("Didn't match")).toBeTruthy();
});

test("a 2xx answer that is no error is relayed: nothing lights up", async () => {
  const user = userEvent.setup();
  renderTab(decided({ failure: false, rule: undefined, outcome: undefined, status: 200, reason: undefined, key_effect: "No change", request_effect: "Relay the answer" }));
  const p = await panel();
  await user.click(within(p).getByRole("button", { name: "200 with an error" }));
  await user.click(within(p).getByRole("button", { name: "Try this failure" }));
  expect((await within(p).findByRole("status")).textContent).toContain("Not a failure: Iroha relays this answer to the Caller; no rule is tried.");
  expect(steps().some((s) => s.hasAttribute("data-trace"))).toBe(false);
});

test("editing the failure clears the highlight", async () => {
  const user = userEvent.setup();
  renderTab();
  const p = await panel();
  await user.click(within(p).getByRole("button", { name: "429 cooling" }));
  await user.click(within(p).getByRole("button", { name: "Try this failure" }));
  await within(p).findByRole("status");
  await user.type(within(p).getByRole("textbox", { name: "Body" }), " ");
  expect(within(p).queryByRole("status")).toBeNull();
  expect(steps().some((s) => s.hasAttribute("data-trace"))).toBe(false);
});

test("on a phone the path lights up the same way, stacked", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(max-width: 767px)", media: q, addEventListener() {}, removeEventListener() {} }));
  renderTab();
  const p = await panel();
  await user.click(within(p).getByRole("button", { name: "429 cooling" }));
  await user.click(within(p).getByRole("button", { name: "Try this failure" }));
  await within(p).findByRole("status");
  const rate = steps()[2];
  expect(rate.getAttribute("aria-current")).toBe("step");
  expect(rate.textContent).toContain("It matches, so");
  expect(rate.textContent).toContain("Cool 30 s for the model");
});

test("an agent fills in a failure and tries it", async () => {
  const fetch = renderTab();
  await panel();
  const entries = agent.snapshot().filter((e) => !e.offPage && e.component !== "more");
  for (const e of entries) expect(e.label, `${e.component} ${e.ref} has no name`).toBeTruthy();
  const labels = entries.map((e) => e.label);
  for (const l of ["Status", "Body", "Headers", "Try this failure", "429 cooling", "401 invalid key", "404 model not found", "200 with an error"]) expect(labels, `${l} is missing`).toContain(l);
  const run = await agent.act({
    steps: [
      { ref: "Status", action: "setValue", args: ["401"] },
      { ref: "Body", action: "setValue", args: ['{"error":{"code":"invalid_api_key"}}'] },
      { ref: "Try this failure", action: "press" },
    ],
  });
  expect(run.ok, run.error?.message).toBe(true);
  await waitFor(() => expect(classifyCalls(fetch)).toHaveLength(1));
  expect(classifyCalls(fetch)[0].body).toEqual({ status: 401, body: '{"error":{"code":"invalid_api_key"}}' });
});
