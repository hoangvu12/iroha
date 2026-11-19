import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgent } from "@ui-sdk/react/agent";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { COPIED_MS, CopyButton } from "./CopyButton";
import { Toaster } from "./toast";

const agent = createAgent();

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "execCommand");
});

const setup = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

/** What UI SDK's live regions read out last (they fill in after 100 ms). */
async function announced() {
  await act(() => vi.advanceTimersByTimeAsync(150));
  return [...document.querySelectorAll("[data-ui-sdk-announcer]")].map((r) => r.textContent).filter(Boolean);
}

test("a copy button copies its value and says Copied in place, then goes back", async () => {
  const user = setup();
  render(
    <>
      <CopyButton value="gk_secret" what="Gateway Key" />
      <Toaster />
    </>,
  );
  const button = screen.getByRole("button", { name: "Copy the Gateway Key" });
  expect(button.textContent).toBe("Copy");
  await user.click(button);
  expect(await navigator.clipboard.readText()).toBe("gk_secret");
  // The copy resolves after the click, so its render can come a moment later.
  await waitFor(() => expect(button.textContent).toBe("Copied"));
  expect(button.getAttribute("data-copy")).toBe("copied");
  // The result is read out, not toasted.
  expect(await announced()).toContain("Gateway Key copied");
  expect(document.querySelector("[data-slot=toast]")).toBeNull();
  act(() => void vi.advanceTimersByTime(COPIED_MS));
  expect(button.textContent).toBe("Copy");
  expect(button.hasAttribute("data-copy")).toBe(false);
});

/** jsdom lays nothing out: give every element the width of its text (7 px a letter) and record width animations. */
function measureByText() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const width = (this.textContent ?? "").length * 7;
    return { width, height: 16, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 16, toJSON: () => ({}) } as DOMRect;
  });
  const animate = vi.fn((..._args: Parameters<Element["animate"]>) => ({ cancel() {} }) as Animation);
  Object.defineProperty(HTMLElement.prototype, "animate", { value: animate, configurable: true, writable: true });
  // The motion tokens as the production build writes them (minified: ".2s", not "200ms").
  document.documentElement.style.setProperty("--duration-indicator", ".2s");
  document.documentElement.style.setProperty("--ease-out", "cubic-bezier(.23, 1, .32, 1)");
  return animate;
}

afterEach(() => {
  Reflect.deleteProperty(HTMLElement.prototype, "animate");
  document.documentElement.removeAttribute("style");
});

test("at rest the button holds just Copy: nothing keeps the width of Copied", async () => {
  measureByText();
  render(<CopyButton value="gk_secret" what="Gateway Key" />);
  const button = screen.getByRole("button", { name: "Copy the Gateway Key" });
  expect(button.textContent).toBe("Copy");
  // No hidden "Copied" reserving space (the gap the Owner saw), no fixed width.
  expect(button.querySelector("[data-reserve]")).toBeNull();
  for (const el of button.querySelectorAll<HTMLElement>("*")) expect(el.style.width).toBe("");
});

test("changing to Copied and back slides the label's width instead of jumping", async () => {
  const animate = measureByText();
  const user = setup();
  render(<CopyButton value="gk_secret" what="Gateway Key" />);
  const button = screen.getByRole("button", { name: "Copy the Gateway Key" });
  expect(animate).not.toHaveBeenCalled();
  await user.click(button);
  await waitFor(() => expect(button.textContent).toBe("Copied"));
  expect(animate).toHaveBeenCalledTimes(1);
  const [frames, options] = animate.mock.calls[0];
  expect(frames).toEqual([{ width: "28px" }, { width: "42px" }]);
  expect(options).toMatchObject({ duration: 200, easing: "cubic-bezier(.23, 1, .32, 1)" });
  act(() => void vi.advanceTimersByTime(COPIED_MS));
  expect(button.textContent).toBe("Copy");
  expect(animate.mock.calls[1][0]).toEqual([{ width: "42px" }, { width: "28px" }]);
});

test("under reduced motion the label changes at once", async () => {
  const animate = measureByText();
  const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList,
  );
  const user = setup();
  render(<CopyButton value="x" what="Base URL" />);
  const button = screen.getByRole("button", { name: "Copy the Base URL" });
  await user.click(button);
  await waitFor(() => expect(button.textContent).toBe("Copied"));
  expect(animate).not.toHaveBeenCalled();
  matchMedia.mockRestore();
});

test("without the Clipboard API it copies through a hidden textarea and keeps focus", async () => {
  const user = setup();
  render(<CopyButton value="http://iroha.local/v1" what="Base URL" />);
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  const copied: string[] = [];
  document.execCommand = vi.fn(() => {
    copied.push((document.activeElement as HTMLTextAreaElement).value);
    return true;
  });
  const button = screen.getByRole("button", { name: "Copy the Base URL" });
  try {
    await user.click(button);
  } finally {
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
  }
  expect(copied).toEqual(["http://iroha.local/v1"]);
  expect(document.querySelector("textarea")).toBeNull();
  expect(document.activeElement).toBe(button);
  await waitFor(() => expect(button.textContent).toBe("Copied"));
});

test("when the browser refuses, the button says Couldn't copy and the reason is read out", async () => {
  const user = setup();
  render(<CopyButton value="x" what="Request ID" />);
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("Write permission denied."));
  document.execCommand = vi.fn(() => false);
  const button = screen.getByRole("button", { name: "Copy the Request ID" });
  await user.click(button);
  await waitFor(() => expect(button.textContent).toBe("Couldn't copy"));
  expect(button.getAttribute("data-copy")).toBe("failed");
  expect(await announced()).toContain("Couldn't copy the Request ID: Write permission denied.");
});

test("an icon copy button is named by its tooltip, which says Copied after a copy", async () => {
  const user = setup();
  const row = vi.fn();
  render(
    <div onClick={row}>
      <CopyButton icon value="req_1" what="Request ID" />
    </div>,
  );
  const button = screen.getByRole("button", { name: "Copy the Request ID" });
  expect(button.textContent).toBe("");
  await user.click(button);
  expect(await navigator.clipboard.readText()).toBe("req_1");
  expect(await screen.findByRole("button", { name: "Copied" })).toBe(button);
  expect(row).not.toHaveBeenCalled();
  act(() => void vi.advanceTimersByTime(COPIED_MS));
  expect(screen.getByRole("button", { name: "Copy the Request ID" })).toBe(button);
});

test("an agent finds a copy button by name and presses it", async () => {
  setup();
  render(<CopyButton value="sk-1" what="Key" label="Copy key team-1" />);
  const components = agent.snapshot().filter((e) => !e.offPage && e.component !== "more");
  for (const entry of components) expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy();
  expect(components.map((e) => e.label)).toContain("Copy key team-1");
  const result = await agent.act({ steps: [{ ref: "Copy key team-1", action: "press" }] });
  expect(result.ok, result.error?.message).toBe(true);
  expect(await navigator.clipboard.readText()).toBe("sk-1");
});
