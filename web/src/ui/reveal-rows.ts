import { startTransition, useEffect, useState } from "react";

/** Rows rendered with the reveal when many arrive over a skeleton: more than a screen of 48 px rows. */
export const REVEAL_ROWS = 30;

/**
 * The rows to render (UI ticket 26). When many rows replace a skeleton, the
 * reveal is one task: React renders every row, Skullet crossfades and copies
 * the rows to remember their shape, the browser lays them out. With a hundred
 * rows that froze the page for a few frames. So the reveal brings the first
 * `REVEAL_ROWS` (more than fill a window) and the rest follow once that frame
 * is painted, in a transition, which React renders in slices. Rows that were
 * there from the start, a refetch and later changes render whole.
 */
export function useRevealRows<R>(rows: R[], loading: boolean): R[] {
  const [wasLoading, setWasLoading] = useState(loading);
  const [cut, setCut] = useState(false);
  if (wasLoading !== loading) {
    setWasLoading(loading);
    setCut(!loading && rows.length > REVEAL_ROWS);
  }
  useEffect(() => {
    if (!cut) return;
    const frame = requestAnimationFrame(() => startTransition(() => setCut(false)));
    return () => cancelAnimationFrame(frame);
  }, [cut]);
  return cut ? rows.slice(0, REVEAL_ROWS) : rows;
}
