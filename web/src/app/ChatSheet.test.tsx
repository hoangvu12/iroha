import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ChatPanelProvider, useChatActions, useChatPanel } from "./chat-panel";
import { ChatSheet } from "./ChatSheet";
import { useNavShortcuts } from "./shortcuts";

// The chat slot slides in and out when a pointer opened or closed it, and
// is there at once for the C key, Full page and Back to the side panel
// (architecture.md "UI motion system": never animate keyboard actions).

function Harness() {
  useNavShortcuts();
  const chat = useChatPanel();
  return (
    <>
      <button type="button" onClick={() => chat.toggle()}>
        Chat
      </button>
      <ChatSheet hidden={false}>
        <button type="button" onClick={() => chat.close()}>
          Close
        </button>
        <button type="button" onClick={() => chat.close({ instant: true })}>
          Full page
        </button>
      </ChatSheet>
    </>
  );
}

function renderShell() {
  return render(
    <MemoryRouter>
      <ChatPanelProvider>
        <Harness />
      </ChatPanelProvider>
    </MemoryRouter>,
  );
}

const sheet = () => screen.queryByRole("complementary", { name: "Chat" });

// A transition that runs until the test ends it, so a closing sheet has
// something to wait for (jsdom has no real ones).
let endTransitions = () => {};
beforeEach(() => {
  let end = () => {};
  const finished = new Promise<void>((r) => (end = r));
  endTransitions = () => act(end);
  const running = { finished, effect: { getComputedTiming: () => ({ endTime: 60_000, localTime: 0 }) } } as unknown as Animation;
  Element.prototype.getAnimations = () => [running];
});
afterEach(() => {
  Element.prototype.getAnimations = () => [];
});

test("a pointer opens the sheet from its starting style, which then lifts", async () => {
  const user = userEvent.setup();
  renderShell();
  await user.click(screen.getByRole("button", { name: "Chat" }));
  const aside = sheet()!;
  expect(aside).not.toBeNull();
  expect(aside.hasAttribute("data-instant")).toBe(false);
  // animateIn marks the first frame, then removes the mark so the slide runs.
  await waitFor(() => expect(aside.hasAttribute("data-starting-style")).toBe(false));
});

test("the first frame of a pointer open is the off-screen starting style", () => {
  renderShell();
  act(() => screen.getByRole("button", { name: "Chat" }).click());
  expect(sheet()!.hasAttribute("data-starting-style")).toBe(true);
});

test("C opens and closes the sheet at once", async () => {
  const user = userEvent.setup();
  renderShell();
  await user.keyboard("c");
  const aside = sheet()!;
  expect(aside.hasAttribute("data-starting-style")).toBe(false);
  expect(aside.hasAttribute("data-instant")).toBe(true);
  await user.keyboard("c");
  expect(sheet()).toBeNull();
});

test("Close keeps the sheet on screen, inert, until its exit finishes", async () => {
  const user = userEvent.setup();
  renderShell();
  await user.click(screen.getByRole("button", { name: "Chat" }));
  await user.click(screen.getByRole("button", { name: "Close" }));
  const aside = sheet()!;
  expect(aside.hasAttribute("data-ending-style")).toBe(true);
  expect(aside.hasAttribute("inert")).toBe(true);
  endTransitions();
  await waitFor(() => expect(sheet()).toBeNull());
});

test("closing returns focus to the trigger that opened it, not the page body", async () => {
  const user = userEvent.setup();
  renderShell();
  const trigger = screen.getByRole("button", { name: "Chat" });
  await user.click(trigger);
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(document.activeElement).toBe(trigger);
});

test("the C key closing it from inside returns focus to where it was opened", async () => {
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <ChatPanelProvider>
        <OpenFrom />
        <Harness />
      </ChatPanelProvider>
    </MemoryRouter>,
  );
  const test = screen.getByRole("button", { name: "Test acme" });
  await user.click(test);
  // Focus moves into the sheet (its Close button), then C closes it at once.
  screen.getByRole("button", { name: "Close" }).focus();
  await user.keyboard("c");
  expect(sheet()).toBeNull();
  expect(document.activeElement).toBe(test);
});

function OpenFrom() {
  const chat = useChatActions();
  return (
    <button type="button" onClick={() => chat.open({ kind: "provider", provider: "acme" })}>
      Test acme
    </button>
  );
}

test("opening again while it leaves turns it back without remounting", async () => {
  const user = userEvent.setup();
  renderShell();
  await user.click(screen.getByRole("button", { name: "Chat" }));
  const aside = sheet()!;
  await user.click(screen.getByRole("button", { name: "Close" }));
  await user.click(screen.getByRole("button", { name: "Chat" }));
  expect(sheet()).toBe(aside);
  expect(aside.hasAttribute("data-ending-style")).toBe(false);
  expect(aside.hasAttribute("inert")).toBe(false);
  // No new starting style: the running transition turns back from where it is.
  expect(aside.hasAttribute("data-starting-style")).toBe(false);
  // The cancelled exit never unmounts it.
  endTransitions();
  await new Promise((r) => setTimeout(r, 20));
  expect(sheet()).toBe(aside);
});

test("Full page closes it at once", async () => {
  const user = userEvent.setup();
  renderShell();
  await user.click(screen.getByRole("button", { name: "Chat" }));
  await user.click(screen.getByRole("button", { name: "Full page" }));
  expect(sheet()).toBeNull();
});

test("C while it slides out snaps it back open", async () => {
  const user = userEvent.setup();
  renderShell();
  await user.click(screen.getByRole("button", { name: "Chat" }));
  await user.click(screen.getByRole("button", { name: "Close" }));
  // Focus left the inert sheet; the key goes to the page.
  (document.activeElement as HTMLElement | null)?.blur();
  await user.keyboard("c");
  const aside = sheet()!;
  expect(aside.hasAttribute("data-ending-style")).toBe(false);
  expect(aside.hasAttribute("data-instant")).toBe(true);
});

test("opening and closing the sheet doesn't re-render what only opens it (a table of Test buttons)", async () => {
  const user = userEvent.setup();
  let renders = 0;
  function TestButton() {
    renders++;
    const chat = useChatActions();
    return (
      <button type="button" onClick={() => chat.open({ kind: "provider", provider: "acme" })}>
        Test
      </button>
    );
  }
  render(
    <MemoryRouter>
      <ChatPanelProvider>
        <TestButton />
        <Harness />
      </ChatPanelProvider>
    </MemoryRouter>,
  );
  const before = renders;
  await user.click(screen.getByRole("button", { name: "Test" }));
  expect(sheet()).not.toBeNull();
  await user.keyboard("c");
  expect(sheet()).toBeNull();
  expect(renders).toBe(before);
});

test("a hidden slot (the /chat page) renders nothing", () => {
  render(
    <MemoryRouter>
      <ChatPanelProvider>
        <ChatSheet hidden>
          <p>content</p>
        </ChatSheet>
      </ChatPanelProvider>
    </MemoryRouter>,
  );
  expect(sheet()).toBeNull();
});
