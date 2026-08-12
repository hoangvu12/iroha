import { createArgon2idPasswordHasher, type PasswordHasher } from '../../src/identity/index.ts'
import type { Clock } from '../../src/runtime/clock.ts'

/**
 * Real Argon2id at the lowest work factor Bun accepts.
 *
 * Tests sign in dozens of times, and production cost parameters would spend
 * most of the suite's runtime deliberately being slow. The algorithm, salting,
 * and stored format stay exactly as they are in production; only the cost
 * changes, and `test/identity/secrets.test.ts` proves both settings behave
 * identically.
 */
export const testPasswordHasher: PasswordHasher = createArgon2idPasswordHasher({
  memoryCost: 8,
  timeCost: 1,
})

/** A clock the test drives by hand. */
export interface TestClock extends Clock {
  advance(seconds: number): void
  set(at: Date): void
}

export function testClock(start = new Date('2026-01-01T00:00:00.000Z')): TestClock {
  let current = start

  return {
    now: () => current,
    advance: (seconds) => {
      current = new Date(current.getTime() + seconds * 1000)
    },
    set: (at) => {
      current = at
    },
  }
}
