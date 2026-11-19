import { render, screen } from "@testing-library/react";
import { Skeleton } from "skullet/react";
import { afterEach, expect, test, vi } from "vitest";
import { SkeletonRoot } from "./skeletons";
import { ThemeProvider } from "./theme";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

function skulletCSS() {
  return [...document.querySelectorAll("style")].map((s) => s.textContent ?? "").join("\n");
}

test("skeletons are drawn in Iroha's tokens and follow Iroha's theme, not the OS", () => {
  // The OS asks for dark; the Owner chose light in Settings.
  const original = window.matchMedia;
  vi.stubGlobal("matchMedia", (query: string) => ({ ...original(query), matches: query.includes("dark") }));
  localStorage.setItem("iroha.theme", "light");
  render(
    <ThemeProvider>
      <SkeletonRoot>
        <Skeleton data={null} sample={{ name: "sample" }} label="Loading thing">
          {(d) => <p>{d.name}</p>}
        </Skeleton>
      </SkeletonRoot>
    </ThemeProvider>,
  );
  const css = skulletCSS();
  expect(css).toContain("--skullet-base: var(--bg-muted)");
  expect(css).toContain("--skullet-highlight: var(--skeleton-highlight)");
  expect(css).not.toContain("prefers-color-scheme");
  expect(screen.getByText("Loading thing")).toBeTruthy();
});
