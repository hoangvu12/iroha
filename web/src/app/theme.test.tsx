import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ThemeProvider, useTheme } from "./theme";

// The theme flips colours in one step: while the .dark class changes, every
// transition is off (architecture.md "UI motion system": theme switching), so
// hover-coloured parts don't fade 150 ms behind the rest of the page.

function Picker() {
  const { setPref } = useTheme();
  return (
    <>
      <button onClick={() => setPref("dark")}>Dark</button>
      <button onClick={() => setPref("light")}>Light</button>
    </>
  );
}

const html = document.documentElement;
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));

beforeEach(() => {
  localStorage.clear();
  html.className = "";
  // index.html's two theme-color tags (light and dark schemes).
  for (const media of ["(prefers-color-scheme: light)", "(prefers-color-scheme: dark)"]) {
    const meta = Object.assign(document.createElement("meta"), { name: "theme-color", content: "#ffffff" });
    meta.media = media;
    document.head.append(meta);
  }
});

afterEach(() => {
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
});

test("switching the theme turns transitions off for the flip and back on after the next frame", async () => {
  const user = userEvent.setup();
  render(
    <ThemeProvider>
      <Picker />
    </ThemeProvider>,
  );
  await nextFrame();
  await nextFrame();
  expect(html.classList.contains("theme-switching")).toBe(false);

  // Each class change, as the class list before it; the one that adds .dark
  // must already have transitions off.
  const before: string[] = [];
  const observer = new MutationObserver((records) => before.push(...records.map((r) => r.oldValue ?? "")));
  observer.observe(html, { attributes: true, attributeFilter: ["class"], attributeOldValue: true });
  await user.click(screen.getByRole("button", { name: "Dark" }));
  before.push(...observer.takeRecords().map((r) => r.oldValue ?? ""));
  observer.disconnect();

  expect(html.classList.contains("dark")).toBe(true);
  const after = [...before.slice(1), html.className];
  const flip = before.findIndex((b, i) => !b.split(" ").includes("dark") && after[i].split(" ").includes("dark"));
  expect(flip, "a change added .dark").toBeGreaterThanOrEqual(0);
  expect(before[flip].split(" "), "transitions are off when .dark arrives").toContain("theme-switching");
  await act(async () => {
    await nextFrame();
    await nextFrame();
  });
  expect(html.classList.contains("theme-switching")).toBe(false);
});

test("the browser bar colour follows the chosen theme, whatever the system says", async () => {
  const user = userEvent.setup();
  render(
    <ThemeProvider>
      <Picker />
    </ThemeProvider>,
  );
  const metas = () => Array.from(document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')).map((m) => m.content);
  expect(metas()).toEqual(["#ffffff", "#ffffff"]);
  await user.click(screen.getByRole("button", { name: "Dark" }));
  expect(metas()).toEqual(["#0e0e10", "#0e0e10"]);
  await user.click(screen.getByRole("button", { name: "Light" }));
  expect(metas()).toEqual(["#ffffff", "#ffffff"]);
});
