import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { Reveal } from "./controls";

// Motion (UI ticket 17): what appears inside an open dialog drops in with the
// list recipe; what is there when the dialog opens arrives with the dialog.
const RECIPE = ["transition-[opacity,translate]", "duration-list-in", "ease-out", "starting:-translate-y-(--motion-shift-sm)", "starting:opacity-0"];
const box = () => screen.getByText("Header name").parentElement!;

test("shown from the start, it has no entrance of its own", () => {
  render(
    <Reveal show>
      <span>Header name</span>
    </Reveal>,
  );
  for (const c of RECIPE) expect(box().className.split(" ")).not.toContain(c);
});

test("appearing later, it drops in with the list recipe; hidden, it is gone at once", () => {
  const { rerender } = render(
    <Reveal show={false}>
      <span>Header name</span>
    </Reveal>,
  );
  expect(screen.queryByText("Header name")).toBeNull();
  rerender(
    <Reveal show>
      <span>Header name</span>
    </Reveal>,
  );
  expect(box().className.split(" ")).toEqual(expect.arrayContaining(RECIPE));
  rerender(
    <Reveal show={false}>
      <span>Header name</span>
    </Reveal>,
  );
  expect(screen.queryByText("Header name")).toBeNull();
});

test("shown at first, hidden, then shown again, it drops in the second time", () => {
  const { rerender } = render(
    <Reveal show className="mt-4">
      <span>Header name</span>
    </Reveal>,
  );
  rerender(
    <Reveal show={false} className="mt-4">
      <span>Header name</span>
    </Reveal>,
  );
  rerender(
    <Reveal show className="mt-4">
      <span>Header name</span>
    </Reveal>,
  );
  expect(box().className.split(" ")).toEqual(expect.arrayContaining([...RECIPE, "mt-4"]));
});
