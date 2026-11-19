import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { rec, RecordLink } from "./RecordLink";
import { renderWithSheets } from "./test-iroha";

afterEach(() => vi.unstubAllGlobals());

const where = () => screen.getByRole("status", { name: "Location" }).textContent;
const sheets = () => screen.queryAllByRole("dialog");

function Page() {
  return (
    <RecordLink record={rec.provider("acme")} aria-label="acme on the page">
      acme
    </RecordLink>
  );
}

test("Provider then Upstream Key: two sheets side by side, newest focused; Escape closes the top one and focus goes back", async () => {
  const user = userEvent.setup();
  const { router } = renderWithSheets(<Page />);
  const link = screen.getByRole("link", { name: "acme on the page" });
  expect(link.getAttribute("href")).toBe("/page?sheet=provider%3Aacme");

  await user.click(link);
  const providerSheet = await screen.findByRole("dialog", { name: "Provider acme" });
  await waitFor(() => expect(where()).toBe("/page?sheet=provider:acme"));
  expect(providerSheet.contains(document.activeElement)).toBe(true);
  expect(providerSheet.getAttribute("aria-modal")).toBeNull();

  await user.click(await within(providerSheet).findByRole("link", { name: "team-5" }));
  const keySheet = await screen.findByRole("dialog", { name: "Upstream Key team-5" });
  await waitFor(() => expect(where()).toBe("/page?sheet=provider:acme&sheet=key:acme/team-5"));
  expect(keySheet.contains(document.activeElement)).toBe(true);
  expect(providerSheet.getAttribute("data-depth")).toBe("1");
  expect(keySheet.getAttribute("data-depth")).toBe("0");

  const historyBefore = router.state.historyAction;
  await user.keyboard("{Escape}");
  await waitFor(() => expect(sheets()).toHaveLength(1));
  await waitFor(() => expect(where()).toBe("/page?sheet=provider:acme"));
  expect(router.state.historyAction).toBe("POP"); // closing went Back, so Forward reopens it
  expect(historyBefore).toBe("PUSH");
  expect(document.activeElement).toBe(within(providerSheet).getByRole("link", { name: "team-5" }));
  expect(providerSheet.getAttribute("data-depth")).toBe("0");

  await user.keyboard("{Escape}");
  await waitFor(() => expect(sheets()).toHaveLength(0));
  await waitFor(() => expect(where()).toBe("/page"));
  expect(document.activeElement).toBe(link);
});

test("Back and Forward move through the stack; a reload (a fresh router on the URL) restores it with the top sheet focused", async () => {
  const user = userEvent.setup();
  const { router } = renderWithSheets(<Page />);
  await user.click(screen.getByRole("link", { name: "acme on the page" }));
  const providerSheet = await screen.findByRole("dialog", { name: "Provider acme" });
  await user.click(await within(providerSheet).findByRole("link", { name: "team-5" }));
  await screen.findByRole("dialog", { name: "Upstream Key team-5" });

  await act(() => router.navigate(-1));
  await waitFor(() => expect(sheets()).toHaveLength(1));
  await act(() => router.navigate(-1));
  await waitFor(() => expect(sheets()).toHaveLength(0));
  await act(() => router.navigate(2));
  await screen.findByRole("dialog", { name: "Upstream Key team-5" });
  expect(sheets()).toHaveLength(2);
});

test("a shared link opens its whole stack, the top sheet focused", async () => {
  renderWithSheets(<Page />, "/page?sheet=provider:acme&sheet=key:acme/team-6");
  const top = await screen.findByRole("dialog", { name: "Upstream Key team-6" });
  await screen.findByRole("dialog", { name: "Provider acme" });
  await waitFor(() => expect(top.contains(document.activeElement)).toBe(true));
  expect(top.hasAttribute("data-top")).toBe(true);

  // Nothing opened these sheets in this page load: closing the top one moves focus into the one now on top.
  await userEvent.setup().keyboard("{Escape}");
  await waitFor(() => expect(sheets()).toHaveLength(1));
  expect(document.activeElement).toBe(screen.getByRole("dialog", { name: "Provider acme" }));
});

test("opening a record already open focuses it; opening from a lower sheet closes the ones above it first", async () => {
  const user = userEvent.setup();
  renderWithSheets(<Page />, "/page?sheet=provider:acme&sheet=key:acme/team-5");
  const keySheet = await screen.findByRole("dialog", { name: "Upstream Key team-5" });
  const providerSheet = screen.getByRole("dialog", { name: "Provider acme" });

  // The key's "Upstream Key of acme" link names a Provider already open: no duplicate, the key sheet closes.
  await user.click(await within(keySheet).findByRole("link", { name: "acme" }));
  await waitFor(() => expect(sheets()).toHaveLength(1));
  await waitFor(() => expect(where()).toBe("/page?sheet=provider:acme"));

  // From the Provider (now top) open team-5, then from the Provider (lower) open team-6: team-5 closes first.
  await user.click(await within(providerSheet).findByRole("link", { name: "team-5" }));
  await screen.findByRole("dialog", { name: "Upstream Key team-5" });
  await user.click(within(providerSheet).getByRole("link", { name: "team-6" }));
  await screen.findByRole("dialog", { name: "Upstream Key team-6" });
  await waitFor(() => expect(sheets()).toHaveLength(2));
  await waitFor(() => expect(where()).toBe("/page?sheet=provider:acme&sheet=key:acme/team-6"));
});

test("Escape with focus in an older sheet closes only the top sheet; Close on an older sheet closes it and those above", async () => {
  const user = userEvent.setup();
  renderWithSheets(<Page />, "/page?sheet=provider:acme&sheet=key:acme/team-5");
  await screen.findByRole("dialog", { name: "Upstream Key team-5" });
  const providerSheet = screen.getByRole("dialog", { name: "Provider acme" });
  (await within(providerSheet).findByRole("link", { name: "team-6" })).focus();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(sheets()).toHaveLength(1));
  expect(screen.getByRole("dialog", { name: "Provider acme" })).toBe(providerSheet);

  await user.click(within(providerSheet).getByRole("link", { name: "team-6" }));
  await screen.findByRole("dialog", { name: "Upstream Key team-6" });
  await user.click(within(providerSheet).getByRole("button", { name: "Close (Esc)" }));
  await waitFor(() => expect(sheets()).toHaveLength(0));
  await waitFor(() => expect(where()).toBe("/page"));
});

test("Escape on the page closes the top sheet; page shortcuts still see no popup open", async () => {
  const user = userEvent.setup();
  renderWithSheets(<Page />, "/page?sheet=provider:acme");
  await screen.findByRole("dialog", { name: "Provider acme" });
  const { popupOpen } = await import("@/ui/popup");
  expect(popupOpen()).toBe(false);
  screen.getByRole("link", { name: "acme on the page" }).focus();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(sheets()).toHaveLength(0));
});

test("Open page goes to the record's full page and closes the stack", async () => {
  const user = userEvent.setup();
  renderWithSheets(<Page />, "/page?sheet=provider:acme&sheet=key:acme/team-5");
  const keySheet = await screen.findByRole("dialog", { name: "Upstream Key team-5" });
  const open = within(keySheet).getByRole("link", { name: "Open page" });
  expect(open.getAttribute("href")).toBe("/providers/acme/keys?key=team-5");
  await user.click(open);
  await waitFor(() => expect(where()).toBe("/providers/acme/keys?key=team-5"));
  await waitFor(() => expect(sheets()).toHaveLength(0));
});
