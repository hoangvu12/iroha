import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgent } from "@ui-sdk/react/agent";
import { MemoryRouter } from "react-router";
import { expect, test } from "vitest";
import type { Attempt, RequestRecord } from "./api";
import { AttemptList } from "./Attempts";
import { SAMPLE_ATTEMPTS, SAMPLE_REQUEST } from "./samples";

// The Attempts tab's cards (UI ticket 18): each opens and closes on the
// collapse recipe (UI SDK Collapsible, architecture.md "UI motion system"), its
// chevron turns on the same tokens, the first failed one is open on first paint
// (no animation), and stepping to another Request (↑/↓ in the sheet) swaps the
// cards at once with that Request's own default. jsdom has no Tailwind, so
// this reads the classes on the real markup.

const agent = createAgent();

const ok: Attempt = SAMPLE_ATTEMPTS[0];
const refused: Attempt = { ...ok, seq: 1, status: 429, outcome: "cooling_key", rule: "429 cools the key", failure_body: '{"error":"slow down"}', failure_headers: { "retry-after": "30" } };
const failedThenServed: RequestRecord = { ...SAMPLE_REQUEST, id: "req_a", attempt_count: 2, attempts: [refused, { ...ok, seq: 2, upstream_key: "key-08" }] };
const servedFirst: RequestRecord = { ...SAMPLE_REQUEST, id: "req_b", attempt_count: 2, attempts: [{ ...ok, seq: 1 }, { ...ok, seq: 2, upstream_key: "key-08" }] };

const view = (r: RequestRecord) => (
  <MemoryRouter>
    <AttemptList r={r} loading={false} onOpenRoute={() => {}} />
  </MemoryRouter>
);
const classesOf = (el: Element) => el.getAttribute("class")!.split(/\s+/);
const card = (n: number) => screen.getByRole("button", { name: `Attempt ${n}` });

test("an Attempt opens and closes on the collapse recipe; its chevron turns on the same tokens", async () => {
  const user = userEvent.setup();
  render(view(servedFirst));
  expect(card(1).getAttribute("aria-expanded")).toBe("false");
  await user.click(card(1));
  expect(card(1).getAttribute("aria-expanded")).toBe("true");
  const panel = card(1).closest("li")!.querySelector("[data-slot=collapsible-panel]")!;
  expect(panel).toBeTruthy();
  for (const k of ["h-(--collapsible-panel-height)", "overflow-hidden", "transition-[height]", "duration-collapse", "ease-out", "data-starting-style:h-0", "data-ending-style:h-0"])
    expect(classesOf(panel)).toContain(k);
  const chevron = card(1).closest("li")!.querySelector("svg.lucide-chevron-down")!;
  for (const k of ["transition-[rotate]", "duration-collapse", "ease-out"]) expect(classesOf(chevron)).toContain(k);
  expect(classesOf(chevron).filter((k) => k === "transition-transform" || /^duration-\d/.test(k))).toEqual([]);
});

test("the first failed Attempt is open on first paint, without the opening animation", () => {
  render(view(failedThenServed));
  expect(card(1).getAttribute("aria-expanded")).toBe("true");
  expect(card(2).getAttribute("aria-expanded")).toBe("false");
  const panel = card(1).closest("li")!.querySelector("[data-slot=collapsible-panel]")!;
  expect(panel.hasAttribute("data-starting-style")).toBe(false);
  expect(within(panel as HTMLElement).getByText("429 cools the key")).toBeTruthy();
});

test("stepping to another Request swaps the cards at once, each Request with its own default", async () => {
  const user = userEvent.setup();
  const { rerender } = render(view(servedFirst));
  await user.click(card(2));
  rerender(view(failedThenServed));
  expect(card(1).getAttribute("aria-expanded")).toBe("true");
  expect(card(2).getAttribute("aria-expanded")).toBe("false");
  expect(document.querySelector("[data-starting-style], [data-ending-style]")).toBeNull();
});

test("an Attempt's response headers fold on the collapse recipe (the shared Disclosure)", async () => {
  const user = userEvent.setup();
  render(view(failedThenServed));
  const headers = screen.getByRole("button", { name: /Response headers \(1\)/ });
  expect(headers.getAttribute("aria-expanded")).toBe("false");
  await user.click(headers);
  expect(headers.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText(/retry-after: 30/)).toBeTruthy();
});

test("an agent opens an Attempt by its name", async () => {
  render(view(servedFirst));
  const entries = agent.snapshot().filter((e) => !e.offPage);
  for (const e of entries) expect(e.label, `${e.component} ${e.ref} has no name`).toBeTruthy();
  expect(entries.map((e) => e.label)).toContain("Attempt 2");
  const res = await agent.act({ steps: [{ ref: "Attempt 2", action: "setOpen", args: [true] }] });
  expect(res.ok, res.error?.message).toBe(true);
  expect(card(2).getAttribute("aria-expanded")).toBe("true");
});
