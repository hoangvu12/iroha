import type { Timer } from '../../src/runtime/timer.ts'

/**
 * A timer the test drives by hand, so streaming deadlines can be exercised
 * without sleeping on the wall clock. `advance` moves the clock; `flush` runs
 * every scheduled callback whose deadline has passed, oldest first.
 */
export interface FakeTimer extends Timer {
  readonly elapsedMs: number
  advance(ms: number): void
  flush(): void
}

export function fakeTimer(): FakeTimer {
  let now = 0
  let nextId = 1
  const scheduled = new Map<number, { at: number; callback: () => void }>()

  return {
    get elapsedMs() {
      return now
    },
    now: () => now,
    set(callback, ms) {
      const id = nextId++
      scheduled.set(id, { at: now + ms, callback })
      return () => {
        scheduled.delete(id)
      }
    },
    advance(ms) {
      now += ms
    },
    flush() {
      const due = [...scheduled.entries()]
        .filter(([, entry]) => entry.at <= now)
        .sort((a, b) => a[1].at - b[1].at)
      for (const [id, entry] of due) {
        scheduled.delete(id)
        entry.callback()
      }
    },
  }
}
