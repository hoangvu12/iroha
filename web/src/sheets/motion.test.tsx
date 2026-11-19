import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { useChatActions } from "@/app/chat-panel";
import { CHAT_WIDTH } from "@/app/ChatSheet";
import { rec, RecordLink } from "./RecordLink";
import { loadedSheet, renderWithSheets } from "./test-iroha";

// UI ticket 15: how the stack moves (architecture.md "UI motion system",
// Sheet recipe). jsdom runs no transitions, so these read what the CSS is
// given: the state attributes and the recipe's classes on the real markup.

afterEach(() => vi.unstubAllGlobals());

const where = () => screen.getByRole("status", { name: "Location" }).textContent;
const sheets = () => screen.queryAllByRole("dialog");
const style = (el: HTMLElement, prop: string) => el.style.getPropertyValue(prop).trim();

function Page() {
  const chat = useChatActions();
  return (
    <>
      <RecordLink record={rec.provider("acme")} aria-label="acme on the page">
        acme
      </RecordLink>
      <button type="button" onClick={() => chat.open()}>
        Chat
      </button>
      <button type="button" onClick={() => chat.close()}>
        Close chat
      </button>
      <button type="button" onClick={() => chat.toggle({ instant: true })}>
        Chat by key
      </button>
    </>
  );
}

test("a sheet enters and leaves by the Sheet recipe: translate on the drawer curve, opacity on its own fade", async () => {
  const user = userEvent.setup();
  renderWithSheets(<Page />);
  await user.click(screen.getByRole("link", { name: "acme on the page" }));
  const provider = await loadedSheet("Provider acme");
  const cls = provider.className;
  for (const part of [
    "translate_var(--sheet-move)_var(--ease-drawer)",
    "opacity_var(--duration-fade)_var(--ease-out)",
    "data-starting-style:opacity-0",
    "data-ending-style:opacity-0",
    "data-ending-style:[--sheet-move:var(--duration-sheet-out)]",
  ])
    expect(cls).toContain(part);
  // Only tokens: no typed durations or curves.
  expect(cls).not.toMatch(/duration-\d|ease-\[|cubic-bezier|transition-all/);
});

test("opening steps the older sheet aside on the entering sheet's duration; closing slides it back on the exit's", async () => {
  const user = userEvent.setup();
  renderWithSheets(<Page />);
  await user.click(screen.getByRole("link", { name: "acme on the page" }));
  const provider = await loadedSheet("Provider acme");
  await user.click(await within(provider).findByRole("link", { name: "team-5" }));
  const key = await loadedSheet("Upstream Key team-5");
  expect(provider.getAttribute("data-motion")).toBe("in");
  expect(key.getAttribute("data-motion")).toBe("in");
  expect(provider.className).toContain("data-[motion=out]:[--sheet-move:var(--duration-sheet-out)]");

  await user.click(within(key).getByRole("button", { name: "Close (Esc)" }));
  await waitFor(() => expect(sheets()).toHaveLength(1));
  expect(provider.getAttribute("data-motion")).toBe("out");
});

test("focusing an earlier sheet (a record already open) slides back like a close", async () => {
  const user = userEvent.setup();
  renderWithSheets(<Page />, "/page?sheet=provider:acme&sheet=key:acme/team-5");
  const key = await loadedSheet("Upstream Key team-5");
  const provider = screen.getByRole("dialog", { name: "Provider acme" });
  await user.click(within(key).getByRole("link", { name: "acme" }));
  await waitFor(() => expect(sheets()).toHaveLength(1));
  expect(provider.getAttribute("data-motion")).toBe("out");
});

test("a sheet restored with the page (reload, shared link) is there at once", async () => {
  renderWithSheets(<Page />, "/page?sheet=provider:acme&sheet=key:acme/team-5");
  const key = await loadedSheet("Upstream Key team-5");
  expect(key.getAttribute("data-motion")).toBe("instant");
  expect(screen.getByRole("dialog", { name: "Provider acme" }).getAttribute("data-motion")).toBe("instant");
  expect(key.className).toContain("data-[motion=instant]:transition-none");
});

test("only the top sheet slides in from the edge; a sheet mounted under it fades in its place", async () => {
  renderWithSheets(<Page />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("link", { name: "acme on the page" }));
  const provider = await loadedSheet("Provider acme");
  expect(provider.className).toContain("data-top:data-starting-style:translate-x-");
  expect(provider.className).not.toMatch(/(^|\s)data-starting-style:translate-x-/);
});

test("a record of the same kind takes that sheet's place: same element, nothing enters, focus moves into it, Back swaps it back", async () => {
  const user = userEvent.setup();
  const { router } = renderWithSheets(<Page />, "/page?sheet=provider:acme");
  const provider = await loadedSheet("Provider acme");
  await user.click(await within(provider).findByRole("link", { name: "team-5" }));
  const key = await loadedSheet("Upstream Key team-5");

  // Another key from the Provider's list: the key sheet shows it in place.
  await user.click(within(provider).getByRole("link", { name: "team-6" }));
  expect(key.hasAttribute("data-starting-style")).toBe(false);
  await waitFor(() => expect(where()).toBe("/page?sheet=provider:acme&sheet=key:acme/team-6"));
  expect(await screen.findByRole("dialog", { name: "Upstream Key team-6" })).toBe(key);
  expect(sheets()).toHaveLength(2);
  await waitFor(() => expect(key.contains(document.activeElement)).toBe(true));
  expect(router.state.historyAction).toBe("PUSH");

  await act(() => router.navigate(-1));
  expect(await screen.findByRole("dialog", { name: "Upstream Key team-5" })).toBe(key);
  expect(sheets()).toHaveLength(2);
});

test("an older sheet pushed wholly off screen stays painted until it has slid away", async () => {
  const user = userEvent.setup();
  renderWithSheets(<Page />, "/page?sheet=request:req_1");
  const request = await loadedSheet("Request fast");
  await user.click(within(request).getByRole("link", { name: "acme" }));
  const provider = await loadedSheet("Provider acme");
  await user.click(await within(provider).findByRole("link", { name: "team-5" }));
  await loadedSheet("Upstream Key team-5");
  // jsdom is 1024 px wide: two 540 px sheets fill it, the Request is off screen.
  const away = screen.getByRole("dialog", { name: "Request fast", hidden: true });
  expect(away.hasAttribute("data-away")).toBe(true);
  expect(away.hasAttribute("inert")).toBe(true);
  // Hidden only after the slide: visibility waits for the move (0 s under reduced motion).
  expect(away.className).toContain("visibility_0s_linear_var(--sheet-hide)");
  expect(away.className).toContain("data-away:invisible");
  expect(away.className).toContain("data-away:[--sheet-hide:var(--sheet-move)]");
});

test("the chat opening moves the sheets aside with it by translate (never `right`), and at once when C opened it", async () => {
  const user = userEvent.setup();
  renderWithSheets(<Page />, "/page?sheet=provider:acme");
  const provider = await loadedSheet("Provider acme");
  expect(style(provider, "--sheet-shift")).toBe("0px");

  // A pointer: the chat starts sliding a frame after it mounts (animateIn), and the sheets start with it.
  act(() => screen.getByRole("button", { name: "Chat" }).click());
  expect(style(provider, "--sheet-shift")).toBe("0px");
  await waitFor(() => expect(style(provider, "--sheet-shift")).toBe(`${CHAT_WIDTH}px`));
  expect(style(provider, "right")).toBe("0px");
  expect(provider.getAttribute("data-motion")).toBe("in");
  // Beside the chat, a sheet entering or leaving is clipped at the chat's edge, so it slides out from under it.
  expect(provider.hasAttribute("data-beside")).toBe(true);
  expect(provider.className).toContain("data-beside:data-top:data-starting-style:[clip-path:inset(0_var(--motion-sheet-offset)_0_0)]");

  await user.click(screen.getByRole("button", { name: "Close chat" }));
  expect(style(provider, "--sheet-shift")).toBe("0px");
  expect(provider.getAttribute("data-motion")).toBe("out");

  await user.click(screen.getByRole("button", { name: "Chat by key" }));
  expect(style(provider, "--sheet-shift")).toBe(`${CHAT_WIDTH}px`);
  expect(provider.getAttribute("data-motion")).toBe("instant");
});
