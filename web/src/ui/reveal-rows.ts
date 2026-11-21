import { startTransition, useEffect, useState } from "react";

export const REVEAL_ROWS = 30;

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
