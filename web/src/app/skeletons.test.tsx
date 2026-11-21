import { render, screen } from "@testing-library/react";
import { Skeleton } from "skullet/react";
import { afterEach, expect, test, vi } from "vitest";
import type { RevealContext } from "skullet";
import { SKELETON_REVEAL, SkeletonRoot, revealFor } from "./skeletons";
import { ThemeProvider } from "./theme";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

function skulletCSS() {
  return [...document.querySelectorAll("style")].map((s) => s.textContent ?? "").join("\n");
}

const ctx = (o: Partial<RevealContext>): RevealContext => ({
  content: document.createElement("div"),
  reveal: document.createElement("div"),
  waited: 1200,
  input: false,
  refetch: false,
  height: 600,
  pieces: 30,
  ...o,
});

test("a reveal of many pieces (a big table) crossfades whole; a small one still comes in row by row", () => {
  expect(typeof revealFor(ctx({ pieces: 30 })).order).toBe("function");
  expect(typeof revealFor(ctx({ pieces: 60 })).order).toBe("function");
  expect(revealFor(ctx({ pieces: 61 })).order).toBe("together");
  expect(revealFor(ctx({ pieces: 716, height: 2632 })).order).toBe("together");
  expect(revealFor(ctx({ pieces: 716 })).duration ?? 200).toBeGreaterThan(0);
});

test("a fast load or one during a gesture shows at once and a refetch crossfades quickly, whatever its size", () => {
  expect(revealFor(ctx({ pieces: 716, waited: 80 })).duration).toBe(0);
  expect(revealFor(ctx({ pieces: 716, input: true })).duration).toBe(0);
  expect(revealFor(ctx({ pieces: 716, refetch: true }))).toMatchObject({ order: "together", duration: 120 });
  expect(revealFor(ctx({ pieces: 2 })).order).toBe("together");
});

test("skeletons still wait 150 ms before they show", () => {
  expect(SKELETON_REVEAL.hold).toBe(150);
  expect(SKELETON_REVEAL.choose?.(ctx({ pieces: 716 })).order).toBe("together");
});

test("skeletons are drawn in Iroha's tokens and follow Iroha's theme, not the OS", () => {
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
