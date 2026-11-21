import { createController, createViewport, css, definePrimitive, live } from "@ui-sdk/core";

export function createCanvasController() {
  return createController<{ zoomIn: () => void; zoomOut: () => void; reset: () => void }>();
}
export type CanvasController = ReturnType<typeof createCanvasController>;

type CanvasOptions = { minZoom?: number; maxZoom?: number; controller?: CanvasController };

const STEP = 1.2;
const field = (t: EventTarget | null) => t instanceof Element && !!t.closest("input, textarea, select, [contenteditable], [role=combobox]");
const control = (t: EventTarget | null) =>
  t instanceof Element && !!t.closest("button, a, input, textarea, select, label, [role=combobox], [data-canvas-no-pan]");

export const canvas = definePrimitive({
  name: "canvas",
  options: { minZoom: "number", maxZoom: "number", controller: "value" },
  state: (_options: CanvasOptions) => ({ viewport: { x: 0, y: 0, zoom: 1 } }),
  live: ["viewport"],
  api: (context) => {
    const viewport = createViewport(context, {
      key: "viewport",
      surface: () => context.element("root"),
      minZoom: () => context.options().minZoom ?? 0.4,
      maxZoom: () => context.options().maxZoom ?? 2,
    });
    return {
      viewport,
      zoomIn: () => void viewport.zoomBy(STEP),
      zoomOut: () => void viewport.zoomBy(1 / STEP),
      reset: () => void viewport.setViewport({ x: 0, y: 0, zoom: 1 }),
    };
  },
  slots: (slot) => ({
    root: slot({
      role: "group",
      attrs: () => ({
        tabindex: "0",
        "aria-roledescription": "canvas",
        style: css({ position: "relative", overflow: "clip", "touch-action": "none" }),
      }),
      on: {
        wheel: (event, { api }) => api.viewport.wheel(event as WheelEvent),
        pointerdown: (event, { api }) => {
          if (!control(event.target)) api.viewport.pointerdown(event as PointerEvent);
        },
        keydown: (event, { api }) => {
          if (!field(event.target)) api.viewport.keydown(event as KeyboardEvent);
        },
        focusin: (event, { el, api }) => {
          const t = event.target;
          if (el && t instanceof Element && t !== el && t.closest('[data-slot="canvas-world"]'))
            api.viewport.reveal(api.viewport.rectOf(t), { padding: 24 });
        },
      },
    }),
    world: slot({
      attrs: () => ({ style: css({ position: "absolute", left: "0", top: "0" }) }),
      live: live((state, { api }) => ({ style: api.viewport.style(state) })),
    }),
    level: slot<{}, { percent: number }>({
      state: (state) => ({ percent: Math.round(state.viewport.zoom * 100) }),
      attrs: () => ({ "aria-live": "off" }),
    }),
  }),
  agent: { actions: ["zoomIn", "zoomOut", "reset"] },
});
