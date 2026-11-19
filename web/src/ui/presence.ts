import { useLayoutEffect, useRef, useState } from "react";
import { animateOut } from "@ui-sdk/core";

/**
 * Keeps what an element showed on screen while it fades out (UI SDK's
 * `animateOut`: `data-ending-style`, inert until the exit ends), for parts
 * that aren't UI SDK popups: the bulk bar, a save's result. `value` is what to
 * draw, `undefined` when it should go; `shown` is that value, or the last one
 * while it leaves. Put `ref` on the element and style its exit with
 * `data-ending-style:` (architecture.md "UI motion system"). A value that
 * comes back mid-exit turns the element back from where it is.
 */
export function useLeaving<T, E extends HTMLElement = HTMLElement>(value: T | undefined) {
  const ref = useRef<E>(null);
  const last = useRef(value);
  if (value !== undefined) last.current = value;
  const live = value !== undefined;
  const [wasLive, setWasLive] = useState(live);
  const [leaving, setLeaving] = useState(false);
  if (live !== wasLive) {
    // Derived during render, so the element is never dropped for a frame before its exit starts.
    setWasLive(live);
    setLeaving(!live);
  }
  useLayoutEffect(() => {
    if (!leaving) return;
    const el = ref.current;
    if (!el) return setLeaving(false);
    return animateOut(el, () => setLeaving(false));
  }, [leaving]);
  return { shown: live ? value : leaving ? last.current : undefined, leaving, ref };
}
