/**
 * The current time, injected so that expiry, sliding renewal, and throttling
 * windows can be exercised without waiting for real time to pass.
 */
export interface Clock {
  now(): Date
}

export const systemClock: Clock = { now: () => new Date() }
