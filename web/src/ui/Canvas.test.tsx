import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAgent } from "@ui-sdk/react/agent";
import { beforeAll, expect, test } from "vitest";
import { Canvas } from "./Canvas";

const agent = createAgent();
beforeAll(() => document.documentElement.style.setProperty("--duration-move", "250ms"));
const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));

function Route() {
  return (
    <Canvas label="Route of req_1" overlay={<span>Live</span>}>
      <button type="button">Start</button>
      <button type="button">Attempt 1</button>
    </Canvas>
  );
}

const level = () => screen.getByLabelText("Zoom level").textContent;
const world = () => document.querySelector('[data-slot="canvas-world"]') as HTMLElement;

test("the canvas is a named, focusable frame that clips instead of scrolling", async () => {
  render(<Route />);
  await settle();
  const frame = screen.getByRole("group", { name: "Route of req_1" });
  expect(frame.getAttribute("tabindex")).toBe("0");
  expect(frame.style.overflow).toBe("clip");
  expect(frame.style.touchAction).toBe("none");
  expect(world().contains(screen.getByRole("button", { name: "Attempt 1" }))).toBe(true);
  expect(world().contains(screen.getByText("Live"))).toBe(false);
  expect(level()).toBe("100%");
});

test("Zoom in, Zoom out and Reset the view change the scale the world is drawn at", async () => {
  const user = userEvent.setup();
  render(<Route />);
  await settle();
  const before = world().style.transform;
  await user.click(screen.getByRole("button", { name: "Zoom in" }));
  expect(level()).toBe("120%");
  expect(world().style.transform).not.toBe(before);
  await user.click(screen.getByRole("button", { name: "Zoom out" }));
  await user.click(screen.getByRole("button", { name: "Zoom out" }));
  expect(level()).toBe("83%");
  await user.click(screen.getByRole("button", { name: "Reset the view" }));
  expect(level()).toBe("100%");
  expect(world().style.transform).toBe(before);
});

test("with the frame focused, + zooms in, - zooms out and 0 goes back to 100%", async () => {
  render(<Route />);
  await settle();
  const frame = screen.getByRole("group", { name: "Route of req_1" });
  frame.focus();
  fireEvent.keyDown(frame, { key: "+" });
  await settle();
  expect(Number.parseInt(level()!)).toBeGreaterThan(100);
  fireEvent.keyDown(frame, { key: "0" });
  await settle();
  expect(level()).toBe("100%");
  fireEvent.keyDown(frame, { key: "-" });
  await settle();
  expect(Number.parseInt(level()!)).toBeLessThan(100);
});

test("an agent finds every control by name and can zoom", async () => {
  render(<Route />);
  await settle();
  const entries = agent.snapshot().filter((e) => !e.offPage && e.component !== "more");
  expect(entries.every((e) => e.label)).toBe(true);
  const labels = entries.map((e) => e.label);
  expect(labels).toEqual(expect.arrayContaining(["Zoom in", "Zoom out", "Reset the view"]));
  const result = await agent.act({ steps: [{ ref: "Zoom in", action: "press" }] });
  expect(result.ok).toBe(true);
  await settle();
  expect(level()).toBe("120%");
});

test("a zoom button glides the world; the wheel and a pan drop the glide at once; + - 0 never glide", async () => {
  const user = userEvent.setup();
  render(<Route />);
  await settle();
  expect(world().className).toContain("data-glide:transition-[transform]");
  expect(world().className).toContain("data-glide:duration-move");
  expect(world().className).toContain("data-glide:ease-in-out");
  expect(world().hasAttribute("data-glide")).toBe(false);
  await user.click(screen.getByRole("button", { name: "Zoom in" }));
  expect(world().hasAttribute("data-glide")).toBe(true);
  const frame = screen.getByRole("group", { name: "Route of req_1" });
  fireEvent.wheel(frame, { deltaY: 40 });
  expect(world().hasAttribute("data-glide")).toBe(false);
  await user.click(screen.getByRole("button", { name: "Reset the view" }));
  expect(world().hasAttribute("data-glide")).toBe(true);
  fireEvent.pointerDown(frame, { button: 0, pointerId: 1 });
  expect(world().hasAttribute("data-glide")).toBe(false);
  frame.focus();
  fireEvent.keyDown(frame, { key: "+" });
  await settle();
  expect(world().hasAttribute("data-glide")).toBe(false);
});

test("a press on a card glides the pan that brings it into view; Tab to it doesn't", async () => {
  render(<Route />);
  await settle();
  fireEvent.pointerDown(screen.getByRole("button", { name: "Attempt 1" }), { button: 0, pointerId: 1 });
  expect(world().hasAttribute("data-glide")).toBe(true);
  fireEvent.wheel(screen.getByRole("group", { name: "Route of req_1" }), { deltaY: 40 });
  screen.getByRole("button", { name: "Start" }).focus();
  expect(world().hasAttribute("data-glide")).toBe(false);
});
