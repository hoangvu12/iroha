import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
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
