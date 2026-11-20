import { useLayoutEffect, useRef } from "react";
import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { ProviderTile } from "./LogoTile";

// UI ticket 26: when rows replace a skeleton, Skullet (in its pane's layout
// effect) gives every image still loading a shimmering block of its own, reading
// boxes and writing styles for each in turn: on the Requests feed that was a
// third of a second of the reveal at 4x CPU. A tile's image gets its source once
// the rows are on screen, so at that moment there is no image loading.
test("a logo tile's image has no source yet while the rows around it are put on the page, and gets it right after", () => {
  const seen: (string | null)[] = [];
  function Rows() {
    const ref = useRef<HTMLUListElement>(null);
    useLayoutEffect(() => {
      for (const img of ref.current!.querySelectorAll("img")) seen.push(img.getAttribute("src"));
    }, []);
    return (
      <ul ref={ref}>
        {["acme", "zeta"].map((h) => (
          <li key={h}>
            <ProviderTile handle={h} />
          </li>
        ))}
      </ul>
    );
  }
  const { container } = render(<Rows />);
  expect(seen).toEqual([null, null]);
  expect([...container.querySelectorAll("img")].map((i) => i.getAttribute("src"))).toEqual(["/api/providers/acme/logo", "/api/providers/zeta/logo"]);
});

test("a logo tile shows a new source when it changes, and the first letter when it fails", () => {
  const { container, rerender } = render(<ProviderTile handle="acme" />);
  rerender(<ProviderTile handle="acme" version="acme.dev" />);
  expect(container.querySelector("img")?.getAttribute("src")).toContain("acme.dev");
  container.querySelector("img")!.dispatchEvent(new Event("error"));
  rerender(<ProviderTile handle="acme" version="acme.dev" />);
  expect(container.textContent).toBe("A");
});
