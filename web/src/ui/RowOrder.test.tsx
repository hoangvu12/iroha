import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { RowHandle, RowOrder } from "./RowOrder";

// Motion of a reorder (UI ticket 17): while a pointer drags a row it follows
// the pointer 1:1 and the rows it passes slide out of its way (WAAPI on
// transform, --duration-move, --ease-in-out); on drop it settles into its
// slot. The keyboard and code move rows at once.

const H = 40; // every row is 40 px tall in this fake layout

function List({ onChange = () => {} }: { onChange?: (keys: string[]) => void }) {
  const [value, setValue] = useState(["a", "b", "c"]);
  return (
    <RowOrder
      label="Order of fast's members"
      value={value}
      onValueChange={(v) => {
        setValue(v);
        onChange(v);
      }}
    >
      {({ order }) => (
        <ul aria-label="Members">
          {order.map((k) => (
            <li key={k} data-row-id={k}>
              <RowHandle value={k} name={k} />
              {k}
            </li>
          ))}
        </ul>
      )}
    </RowOrder>
  );
}

const rows = () => within(screen.getByRole("list", { name: "Members" })).getAllByRole("listitem");
const row = (k: string) => rows().find((r) => r.dataset.rowId === k)!;
const handle = (k: string) => screen.getByRole("button", { name: `Reorder ${k}` });
const shown = () => rows().map((r) => r.dataset.rowId);

// jsdom lays nothing out: each row sits at its index times H, its handle with it.
const indexOf = (el: Element) => {
  const li = el.closest("li");
  return li ? [...li.parentElement!.children].indexOf(li) : 0;
};
beforeAll(() => {
  document.documentElement.style.setProperty("--duration-move", "250ms");
  document.documentElement.style.setProperty("--ease-in-out", "cubic-bezier(0.77, 0, 0.175, 1)");
  Object.defineProperty(HTMLElement.prototype, "offsetTop", { configurable: true, get: function (this: HTMLElement) { return this.tagName === "LI" ? indexOf(this) * H : 0; } });
  Object.defineProperty(HTMLElement.prototype, "offsetLeft", { configurable: true, get: () => 0 });
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const top = indexOf(this) * H;
    return { top, bottom: top + H, left: 0, right: 200, width: 200, height: H, x: 0, y: top, toJSON() {} } as DOMRect;
  };
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLElement.prototype.releasePointerCapture = () => {};
  HTMLElement.prototype.hasPointerCapture = () => false;
});

let animate: ReturnType<typeof vi.fn>;
beforeEach(() => {
  animate = vi.fn(() => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation);
  Element.prototype.animate = animate as unknown as Element["animate"];
});
afterEach(() => {
  Element.prototype.getAnimations = () => [];
});

const glidesOf = (k: string) => animate.mock.contexts.flatMap((el, i) => (el === row(k) ? [animate.mock.calls[i]] : []));

// A mouse on a handle; UI SDK reads moves once a frame.
const frame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
const mouse = { pointerId: 1, clientX: 10, isPrimary: true, pointerType: "mouse" };
const press = (el: Element, y: number) => fireEvent.pointerDown(el, { ...mouse, button: 0, buttons: 1, clientY: y });
const move = async (el: Element, y: number) => {
  fireEvent.pointerMove(el, { ...mouse, buttons: 1, clientY: y });
  await frame();
};
const release = async (el: Element, y: number) => {
  fireEvent.pointerUp(el, { ...mouse, button: 0, buttons: 0, clientY: y });
  await frame();
};
const GLIDE = expect.objectContaining({ duration: 250, easing: "cubic-bezier(0.77, 0, 0.175, 1)" });

test("a dragged row follows the pointer; the row it passes slides into its new place; the drop settles", async () => {
  const saved = vi.fn();
  render(<List onChange={saved} />);
  const a = handle("a");
  press(a, 20);
  await move(a, 30);
  // Past the drag threshold the row is up and under the pointer.
  expect(row("a").style.transform).toBe("translateY(10px)");
  expect(animate).not.toHaveBeenCalled();

  // Past b's middle (60): b slides up from where it was (40 px below), a stays under the pointer.
  await move(a, 70);
  expect(shown()).toEqual(["b", "a", "c"]);
  expect(row("a").style.transform).toBe("translateY(10px)"); // 50 px down the pointer, 40 px down the list
  expect(glidesOf("b")).toEqual([[[{ transform: "translateY(40px)" }, { transform: "none" }], GLIDE]]);
  expect(glidesOf("c")).toEqual([]);

  await release(a, 70);
  expect(saved).toHaveBeenCalledWith(["b", "a", "c"]);
  expect(shown()).toEqual(["b", "a", "c"]);
  expect(glidesOf("b")).toHaveLength(1); // the drop doesn't send b back and forth
  // The dropped row settles from where the pointer left it into its slot.
  expect(row("a").style.transform).toBe("");
  expect(glidesOf("a")).toEqual([[[{ transform: "translateY(10px)" }, { transform: "none" }], GLIDE]]);
});

test("the keyboard moves rows at once: nothing slides", async () => {
  const user = userEvent.setup();
  render(<List />);
  handle("a").focus();
  await user.keyboard(" {ArrowDown}{ArrowDown} ");
  expect(shown()).toEqual(["b", "c", "a"]);
  expect(animate).not.toHaveBeenCalled();
  expect(row("a").style.transform).toBe("");
});

test("under reduced motion (a 0 ms move) the rows still reorder and the dragged row follows, but nothing slides", async () => {
  document.documentElement.style.setProperty("--duration-move", "0ms");
  try {
    render(<List />);
    const a = handle("a");
    press(a, 20);
    await move(a, 30);
    await move(a, 70);
    expect(shown()).toEqual(["b", "a", "c"]);
    expect(row("a").style.transform).toBe("translateY(10px)");
    await release(a, 70);
    expect(animate).not.toHaveBeenCalled();
    expect(row("a").style.transform).toBe("");
  } finally {
    document.documentElement.style.setProperty("--duration-move", "250ms");
  }
});