/**
 * Monotonic time and one-shot deadlines, injected so that streaming timeouts
 * can be exercised deterministically instead of sleeping on the wall clock.
 * The business-time `Clock` cannot express these: streaming deadlines need a
 * monotonic origin and an asynchronous firing mechanism.
 */
export interface Timer {
  /** Monotonic milliseconds since an arbitrary but stable origin. */
  now(): number
  /** Schedules `callback` after at least `ms`; the returned function cancels it. */
  set(callback: () => void, ms: number): () => void
}

export const systemTimer: Timer = {
  now: () => performance.now(),
  set: (callback, ms) => {
    const id = setTimeout(callback, ms)
    return () => clearTimeout(id)
  },
}
