import { type ChangeDetails, type ReorderDraft, createChange, createReorder, definePrimitive } from "@ui-sdk/core";

// Rows put in order by a drag handle, built on UI SDK core's createReorder (it
// ships no sortable list). The rows are the page's (a DataTable's), so the
// handle is the bound item: its rect stands for its row's when a drag finds
// its place, and focus stays on it while the keyboard moves it. Space or
// Enter on a handle picks its row up, the arrows (Home, End) move it, Space or
// Enter drops it, Escape puts it back; a pointer drags it. Only a drop
// changes `value`; the rows follow `order` (the draft while one moves).

export type RowOrderReason = "drag" | "move-key" | "imperative";

type RowOrderOptions = {
  /** Row keys in order (controlled). */
  value?: string[];
  defaultValue?: string[];
  onValueChange?: (value: string[], details: ChangeDetails<RowOrderReason>) => void;
  /** What screen readers call a row ("acme (m-1)"), else the handle's text. */
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
      /** Moves the row with `key` to `index` (from 0) at once, like a menu's Move up. */
      move: (key: string, index: number) => reorder.move(key, index),
    };
  },
  slots: (slot) => ({
    root: slot<{}, { order: string[]; moving: string | null }>({
      state: (state) => ({ order: state.moving?.order ?? state.value, moving: state.moving?.key ?? null }),
    }),
    handle: slot<{ value: string }>({
      role: "button",
      focus: "native",
      press: { none: "Space and Enter pick the row up and drop it, in keydown; a click alone does nothing." },
      // "string", not "key": the React adapter reads a "key" prop through api internals only UI SDK's own parts have.
      // A part is keyed by its `value` either way.
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
