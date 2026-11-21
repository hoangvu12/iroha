import { type ChangeDetails, type ReorderDraft, createChange, createReorder, definePrimitive } from "@ui-sdk/core";

export type RowOrderReason = "drag" | "move-key" | "imperative";

type RowOrderOptions = {
  value?: string[];
  defaultValue?: string[];
  onValueChange?: (value: string[], details: ChangeDetails<RowOrderReason>) => void;
  itemLabel?: (key: string) => string | undefined;
};

export const rowOrder = definePrimitive({
  name: "row-order",
  options: { value: "list", defaultValue: "list", onValueChange: "callback", itemLabel: "value" },
  controlled: ["value"],
  state: (options: RowOrderOptions) => ({ value: options.value ?? options.defaultValue ?? [], moving: null as ReorderDraft | null }),
  sync: (options) => (options.value === undefined ? {} : { value: options.value }),
  api: (context) => {
    const change = createChange(context);
    const reorder = createReorder(context, {
      slot: "handle",
      key: "value",
      draft: "moving",
      set: (value, details) => change("value", value, details),
      label: (key) => context.options().itemLabel?.(key),
    });
    return {
      reorder,
      move: (key: string, index: number) => reorder.move(key, index),
    };
  },
  slots: (slot) => ({
    root: slot<{}, { order: string[]; moving: string | null; dragging: boolean }>({
      state: (state) => ({ order: state.moving?.order ?? state.value, moving: state.moving?.key ?? null, dragging: !!state.moving?.pointer }),
    }),
    handle: slot<{ value: string }>({
      role: "button",
      focus: "native",
      press: { none: "Space and Enter pick the row up and drop it, in keydown; a click alone does nothing." },
      props: { value: "string" },
      attrs: (state, part) => ({
        type: "button",
        "aria-roledescription": "drag handle",
        "data-grabbed": state.moving?.key === part.key ? "" : undefined,
      }),
      on: {
        keydown: (event, { api, key }) => void api.reorder.keydown(event as KeyboardEvent, key),
        pointerdown: (event, { api, key }) => api.reorder.pointerdown(event as PointerEvent, key),
      },
      bind: (el, part) => part.api.reorder.bind(el, part),
    }),
  }),
  agent: { actions: ["move"] },
});
