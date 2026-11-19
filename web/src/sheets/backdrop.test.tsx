import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { useChatPanel } from "@/app/chat-panel";
import { rec, RecordLink } from "./RecordLink";
import { loadedSheet, renderWithSheets } from "./test-iroha";

// UI ticket 27: one backdrop under the whole stack; a click on it closes the
// stack, a click on a lower sheet brings that sheet forward.

afterEach(() => vi.unstubAllGlobals());

const where = () => screen.getByRole("status", { name: "Location" }).textContent;
const sheets = () => screen.queryAllByRole("dialog");
const backdrops = () => document.querySelectorAll<HTMLElement>("[data-sheet-backdrop]");
const backdrop = () => backdrops()[0];

function Page() {
  const chat = useChatPanel();
  return (
    <>
      <RecordLink record={rec.provider("acme")} aria-label="acme on the page">
        acme
      </RecordLink>
      <output aria-label="Chat">{chat.isOpen ? "open" : "closed"}</output>
    </>
  );
}

test("one backdrop sits under the whole stack while a sheet is open, on the sheet tokens", async () => {
  const user = userEvent.setup();
  renderWithSheets(<Page />);
  expect(backdrops()).toHaveLength(1);
  expect(backdrop().hasAttribute("data-open")).toBe(false);
  expect(backdrop().getAttribute("aria-hidden")).toBe("true");

  await user.click(screen.getByRole("link", { name: "acme on the page" }));
  const provider = await loadedSheet("Provider acme");
  expect(backdrop().hasAttribute("data-open")).toBe(true);
  await user.click(await within(provider).findByRole("link", { name: "team-5" }));
  await loadedSheet("Upstream Key team-5");
  // Still one, for two sheets.
  expect(backdrops()).toHaveLength(1);

  // Dims with the overlay token and fades on the sheet durations (0 under reduced motion: instant).
  const cls = backdrop().className;
  expect(cls).toContain("bg-overlay");
  expect(cls).toContain("--duration-sheet-in");
  expect(cls).toContain("--duration-sheet-out");
  // Under the chat panel (z-30), above the page and sidebar (z-20).
  expect(cls).toContain("z-[25]");

  await user.keyboard("{Escape}");
  await waitFor(() => expect(sheets()).toHaveLength(1));
  expect(backdrop().hasAttribute("data-open")).toBe(true);
  await user.keyboard("{Escape}");
  await waitFor(() => expect(sheets()).toHaveLength(0));
  expect(backdrop().hasAttribute("data-open")).toBe(false);
});

test("a click on the backdrop closes the whole stack and focus goes back to what opened the first sheet", async () => {
  const user = userEvent.setup();
  renderWithSheets(<Page />);
  const link = screen.getByRole("link", { name: "acme on the page" });
  await user.click(link);
  const provider = await loadedSheet("Provider acme");
  await user.click(await within(provider).findByRole("link", { name: "team-5" }));
  await loadedSheet("Upstream Key team-5");
  await waitFor(() => expect(where()).toBe("/page?sheet=provider:acme&sheet=key:acme/team-5"));

  await user.click(backdrop());
  await waitFor(() => expect(sheets()).toHaveLength(0));
  await waitFor(() => expect(where()).toBe("/page"));
  await waitFor(() => expect(document.activeElement).toBe(link));
  expect(backdrop().hasAttribute("data-open")).toBe(false);
});

test("a click on a lower sheet brings it forward: the sheets above it close", async () => {
  const user = userEvent.setup();
  renderWithSheets(<Page />, "/page?sheet=provider:acme&sheet=key:acme/team-5");
  await loadedSheet("Upstream Key team-5");
  const provider = await loadedSheet("Provider acme");
  // Its title, not a link or a button.
  await user.click(within(provider).getByRole("heading", { name: "Provider acme" }));
  await waitFor(() => expect(sheets()).toHaveLength(1));
  await waitFor(() => expect(where()).toBe("/page?sheet=provider:acme"));
  expect(provider.hasAttribute("data-top")).toBe(true);
  // A click in the top sheet changes nothing.
  await user.click(within(provider).getByRole("heading", { name: "Provider acme" }));
  expect(sheets()).toHaveLength(1);
});

test("Test in Chat from a sheet keeps the stack: the chat is above the backdrop", async () => {
  const user = userEvent.setup();
  renderWithSheets(<Page />, "/page?sheet=provider:acme&sheet=key:acme/team-6");
  const key = await loadedSheet("Upstream Key team-6");
  await user.click(within(key).getByRole("button", { name: "Test team-6 in Chat" }));
  expect(screen.getByRole("status", { name: "Chat" }).textContent).toBe("open");
  expect(sheets()).toHaveLength(2);
  expect(where()).toBe("/page?sheet=provider:acme&sheet=key:acme/team-6");
});
