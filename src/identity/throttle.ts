import { systemClock, type Clock } from '../runtime/clock.ts'

export interface AttemptLimit {
  /** Failures allowed inside one window before the action is refused. */
  readonly attempts: number
  readonly windowSeconds: number
}

export type ThrottleDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterSeconds: number }

/**
 * Where an attempt came from, as far as Iroha can tell. Counting per source
 * matters because the alternative — one counter for the whole installation —
 * lets a stranger lock the Owner out by failing on purpose.
 */
export type AttemptSource = string

/** Used when the runtime cannot tell Iroha who is calling. */
export const UNKNOWN_SOURCE: AttemptSource = 'unknown'

export interface AttemptThrottle<Action extends string> {
  check(action: Action, source: AttemptSource): ThrottleDecision
  recordFailure(action: Action, source: AttemptSource): void
  /** A success clears the count, so ordinary mistyping never locks the Owner out. */
  recordSuccess(action: Action, source: AttemptSource): void
}

interface Window<Action extends string> {
  readonly action: Action
  count: number
  readonly startedAt: number
}

/**
 * Bounds how much memory a flood of distinct sources can occupy. Well past any
 * real Owner's number of devices, and small enough to stay negligible.
 */
const MAXIMUM_TRACKED_SOURCES = 4096

/**
 * A fixed-window failure counter for unauthenticated actions.
 *
 * Iroha is a single process serving a single Owner, so the counters live in
 * memory: there is no second replica to disagree with, and anything that must
 * survive a restart — the Owner, sessions, audit history — is persisted.
 *
 * A reverse proxy that hides the caller's address collapses every caller into
 * one source, which is the behaviour a single shared counter would have had.
 */
export function createAttemptThrottle<Action extends string>(
  limits: Readonly<Record<Action, AttemptLimit>>,
  clock: Clock = systemClock,
): AttemptThrottle<Action> {
  const windows = new Map<string, Window<Action>>()

  const keyOf = (action: Action, source: AttemptSource) => `${action}:${source}`

  const current = (action: Action, source: AttemptSource): Window<Action> | null => {
    const key = keyOf(action, source)
    const window = windows.get(key)
    if (!window) return null

    if (hasExpired(window, limits[action], clock)) {
      windows.delete(key)
      return null
    }

    return window
  }

  const makeRoom = () => {
    for (const [key, window] of windows) {
      if (hasExpired(window, limits[window.action], clock)) windows.delete(key)
    }

    // If every window is still live, the oldest is dropped to keep the map
    // bounded. Losing a count can only ever be generous to the caller.
    if (windows.size >= MAXIMUM_TRACKED_SOURCES) {
      const oldest = [...windows].sort(([, a], [, b]) => a.startedAt - b.startedAt)[0]
      if (oldest) windows.delete(oldest[0])
    }
  }

  return {
    check(action, source) {
      const window = current(action, source)
      const limit = limits[action]

      if (window === null || window.count < limit.attempts) return { allowed: true }

      const remaining = limit.windowSeconds * 1000 - (clock.now().getTime() - window.startedAt)
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(remaining / 1000)) }
    },

    recordFailure(action, source) {
      const window = current(action, source)
      if (window !== null) {
        window.count += 1
        return
      }

      if (windows.size >= MAXIMUM_TRACKED_SOURCES) makeRoom()
      windows.set(keyOf(action, source), { action, count: 1, startedAt: clock.now().getTime() })
    },

    recordSuccess(action, source) {
      windows.delete(keyOf(action, source))
    },
  }
}

function hasExpired(window: Window<string>, limit: AttemptLimit, clock: Clock): boolean {
  return clock.now().getTime() - window.startedAt >= limit.windowSeconds * 1000
}
