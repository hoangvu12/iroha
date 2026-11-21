import { render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useArrivals } from "./arrivals";

type Call = { el: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions };
let calls: Call[] = [];
let observers: { cb: IntersectionObserverCallback; targets: Set<Element> }[] = [];
let reduce = false;

const TOKENS: Record<string, string> = {
  "--motion-shift-sm": "4px",
  "--duration-list-in": "200ms",
  "--duration-flash": "1600ms",
  "--ease-out": "cubic-bezier(0.23, 1, 0.32, 1)",
};

beforeEach(() => {
  calls = [];
  observers = [];
  reduce = false;
  for (const [k, v] of Object.entries(TOKENS)) document.documentElement.style.setProperty(k, v);
  Element.prototype.animate = function (this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
    calls.push({ el: this, keyframes, options });
    return { cancel() {} } as Animation;
  } as Element["animate"];
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduce && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      targets = new Set<Element>();
      constructor(public cb: IntersectionObserverCallback) {
        observers.push(this);
      }
      observe(el: Element) {
        this.targets.add(el);
      }
      unobserve(el: Element) {
        this.targets.delete(el);
      }
      disconnect() {
        this.targets.clear();
      }
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const box = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 800, width: 800, height, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    if (this.getAttribute("role") === "region") return box(0, 400);
    if (this.tagName === "THEAD") return box(0, 40);
    if (this.hasAttribute("data-row-id")) return box(Number(this.dataset.top), 48);
    return box(0, 0);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Feed({ rows, added }: { rows: [string, number][]; added: Set<string> }) {
  const box = useRef<HTMLDivElement>(null);
  useArrivals(box, added);
  return (
    <div ref={box}>
      <div role="region" aria-label="Requests">
        <table>
          <thead>
            <tr>
              <th>Time</th>
            </tr>
          </thead>
          <tbody data-rows="">
            {rows.map(([id, top]) => (
              <tr key={id} data-row-id={id} data-top={top}>
                <td>{id}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const row = (id: string) => document.querySelector(`[data-row-id="${id}"]`)!;
const of = (id: string) => calls.filter((c) => c.el === row(id));
const isEntrance = (c: Call) => "opacity" in c.keyframes[0];
const isFlash = (c: Call) => "backgroundColor" in c.keyframes[0];

test("rows of one poll that land in view rise by shift-sm and fade in together, with the flash, on the tokens", () => {
  const old: [string, number][] = [["req_old", 40]];
  const { rerender } = render(<Feed rows={old} added={new Set()} />);
  expect(calls).toEqual([]);

  rerender(<Feed rows={[["req_b", 40], ["req_a", 88], ["req_old", 136]]} added={new Set(["req_a", "req_b"])} />);
  for (const id of ["req_a", "req_b"]) {
    const enter = of(id).find(isEntrance)!;
    expect(enter.keyframes[0]).toMatchObject({ opacity: 0, translate: "0 4px", offset: 0 });
    expect(enter.options).toMatchObject({ duration: 200, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
    expect(enter.options.delay ?? 0).toBe(0);
    const flash = of(id).find(isFlash)!;
    expect(flash.keyframes).toEqual([{ backgroundColor: "var(--info-tint)", offset: 0 }]);
    expect(flash.options).toMatchObject({ duration: 1600, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
  }
  expect(of("req_old")).toEqual([]);
});

test("a row arriving out of view (the view is held) doesn't enter; it flashes once, when it first comes into view", () => {
  const { rerender } = render(<Feed rows={[["req_old", 40]]} added={new Set()} />);
  rerender(<Feed rows={[["req_new", -8], ["req_old", 40]]} added={new Set(["req_new"])} />);
  expect(of("req_new")).toEqual([]);
  const io = observers.find((o) => o.targets.has(row("req_new")))!;
  expect(io).toBeTruthy();

  io.cb([{ target: row("req_new"), isIntersecting: true } as IntersectionObserverEntry], io as unknown as IntersectionObserver);
  expect(of("req_new").map(isFlash)).toEqual([true]);
  expect(io.targets.has(row("req_new"))).toBe(false);
});

test("a row seen once never animates again, whatever re-renders", () => {
  const added = new Set(["req_new"]);
  const { rerender } = render(<Feed rows={[["req_old", 40]]} added={new Set()} />);
  rerender(<Feed rows={[["req_new", 40], ["req_old", 88]]} added={added} />);
  const n = calls.length;
  rerender(<Feed rows={[["req_new", 40], ["req_old", 88]]} added={new Set(added)} />);
  expect(calls.length).toBe(n);
});

test("reduced motion: no movement; the fade and the colour flash stay", () => {
  reduce = true;
  const { rerender } = render(<Feed rows={[["req_old", 40]]} added={new Set()} />);
  rerender(<Feed rows={[["req_new", 40], ["req_old", 88]]} added={new Set(["req_new"])} />);
  const enter = of("req_new").find(isEntrance)!;
  expect(enter.keyframes[0]).toEqual({ opacity: 0, offset: 0 });
  expect(of("req_new").some(isFlash)).toBe(true);
});
