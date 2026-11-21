import { useLayoutEffect, useRef, useState } from "react";
import { animateOut } from "@ui-sdk/core";

export function useLeaving<T, E extends HTMLElement = HTMLElement>(value: T | undefined) {
  const ref = useRef<E>(null);
  const last = useRef(value);
  if (value !== undefined) last.current = value;
  const live = value !== undefined;
  const [wasLive, setWasLive] = useState(live);
  const [leaving, setLeaving] = useState(false);
  if (live !== wasLive) {
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
