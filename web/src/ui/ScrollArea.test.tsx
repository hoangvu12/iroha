import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { ScrollArea } from "./ScrollArea";

test("a named scroll area is a region whose own bar replaces the browser's", () => {
  render(
    <ScrollArea label="Upstream error" className="h-40">
      <pre>{"{}"}</pre>
    </ScrollArea>,
  );
  const viewport = screen.getByRole("region", { name: "Upstream error" });
  expect(viewport.style.scrollbarWidth).toBe("none");
  const root = viewport.parentElement!;
  expect(root.className).toContain("h-40");
  const bars = root.querySelectorAll('[data-slot="scroll-area-scrollbar"]');
  expect([...bars].map((b) => b.getAttribute("data-orientation"))).toEqual(["vertical"]);
  expect(bars[0].className).not.toContain("invisible");
  expect(viewport.className).toContain("scroll-fade-y");
});

test("the bar fades on the scrollbar motion tokens, never a typed duration", () => {
  render(
    <ScrollArea label="Log" className="h-40">
      <p>line</p>
    </ScrollArea>,
  );
  const bar = screen.getByRole("region", { name: "Log" }).parentElement!.querySelector('[data-slot="scroll-area-scrollbar"]')!;
  const classes = bar.className.split(/\s+/);
  expect(classes).toEqual(expect.arrayContaining(["duration-scrollbar-out", "data-visible:duration-scrollbar-in"]));
  expect(classes.filter((c) => /duration-\d/.test(c))).toEqual([]);
});

test("the viewport is exposed: a ref to it, its scroll events and an inline size on the root", () => {
  const ref = createRef<HTMLDivElement>();
  // React clears currentTarget after dispatch: read the scroll position inside the handler, as a virtualised list does.
  const onScroll = vi.fn((e: { currentTarget: HTMLElement }) => e.currentTarget.scrollTop);
  render(
    <ScrollArea label="Models" viewportRef={ref} onScroll={onScroll} style={{ height: 120 }}>
      <p>many</p>
    </ScrollArea>,
  );
  const viewport = screen.getByRole("region", { name: "Models" });
  expect(ref.current).toBe(viewport);
  expect(viewport.parentElement!.style.height).toBe("120px");
  viewport.scrollTop = 72;
  fireEvent.scroll(viewport);
  expect(onScroll).toHaveBeenCalledTimes(1);
  expect(onScroll.mock.results[0].value).toBe(72);
});

test("a chat log uses role=log; both axes get both bars and the corner", () => {
  render(
    <>
      <ScrollArea label="Messages" role="log" stickToEnd>
        <p>hi</p>
      </ScrollArea>
      <ScrollArea label="Table" axis="both" fade={false}>
        <p>wide</p>
      </ScrollArea>
    </>,
  );
  expect(screen.getByRole("log", { name: "Messages" })).toBeTruthy();
  const table = screen.getByRole("region", { name: "Table" });
  expect(table.className).not.toContain("scroll-fade");
  const root = table.parentElement!;
  expect(root.querySelectorAll('[data-slot="scroll-area-scrollbar"]').length).toBe(2);
  expect(root.querySelector('[data-slot="scroll-area-corner"]')).not.toBeNull();
});

test("bars={false} keeps the bar rendered (so native bars stay hidden) but invisible", () => {
  render(
    <ScrollArea label="Row" bars={false}>
      <p>row</p>
    </ScrollArea>,
  );
  const viewport = screen.getByRole("region", { name: "Row" });
  expect(viewport.style.scrollbarWidth).toBe("none");
  expect(viewport.parentElement!.querySelector('[data-slot="scroll-area-scrollbar"]')!.className).toContain("invisible");
});

test("without a label the viewport has no region role", () => {
  const { container } = render(
    <ScrollArea>
      <p>plain</p>
    </ScrollArea>,
  );
  expect(container.querySelector('[data-slot="scroll-area-viewport"]')!.hasAttribute("role")).toBe(false);
});
