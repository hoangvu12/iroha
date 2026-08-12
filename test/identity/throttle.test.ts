import { describe, expect, test } from 'bun:test'
import { createAttemptThrottle } from '../../src/identity/index.ts'
import { testClock } from '../support/identity.ts'

describe('attempt throttle', () => {
  const limits = { login: { attempts: 3, windowSeconds: 60 } }

  const throttleAt = () => {
    const clock = testClock()
    return { throttle: createAttemptThrottle(limits, clock), advance: clock.advance }
  }

  const failRepeatedly = (
    throttle: ReturnType<typeof throttleAt>['throttle'],
    times: number,
    source = 'first',
  ) => {
    for (let attempt = 0; attempt < times; attempt++) throttle.recordFailure('login', source)
  }

  test('allows attempts below the limit', () => {
    const { throttle } = throttleAt()

    failRepeatedly(throttle, 2)

    expect(throttle.check('login', 'first')).toEqual({ allowed: true })
  })

  test('blocks once the limit is reached and says how long to wait', () => {
    const { throttle } = throttleAt()

    failRepeatedly(throttle, 3)

    expect(throttle.check('login', 'first')).toEqual({ allowed: false, retryAfterSeconds: 60 })
  })

  test('forgets failures once the window passes', () => {
    const { throttle, advance } = throttleAt()

    failRepeatedly(throttle, 3)
    advance(61)

    expect(throttle.check('login', 'first')).toEqual({ allowed: true })
  })

  test('counts down the wait as the window elapses', () => {
    const { throttle, advance } = throttleAt()

    failRepeatedly(throttle, 3)
    advance(45)

    expect(throttle.check('login', 'first')).toEqual({ allowed: false, retryAfterSeconds: 15 })
  })

  test('clears the count after a success', () => {
    const { throttle } = throttleAt()

    failRepeatedly(throttle, 3)
    throttle.recordSuccess('login', 'first')

    expect(throttle.check('login', 'first')).toEqual({ allowed: true })
  })

  test('one source cannot lock another out', () => {
    const { throttle } = throttleAt()

    failRepeatedly(throttle, 3, 'a stranger')

    expect(throttle.check('login', 'a stranger').allowed).toBe(false)
    expect(throttle.check('login', 'the owner').allowed).toBe(true)
  })

  test('keeps separate counts per action', () => {
    const clock = testClock()
    const throttle = createAttemptThrottle(
      { login: { attempts: 1, windowSeconds: 60 }, recovery: { attempts: 5, windowSeconds: 60 } },
      clock,
    )

    throttle.recordFailure('login', 'first')

    expect(throttle.check('login', 'first').allowed).toBe(false)
    expect(throttle.check('recovery', 'first').allowed).toBe(true)
  })

  test('stays bounded when a flood of sources fails', () => {
    const { throttle } = throttleAt()

    for (let source = 0; source < 5000; source++) {
      throttle.recordFailure('login', `source-${source}`)
    }

    // The newest sources are still counted; the eviction is invisible except
    // that memory does not grow without limit.
    expect(throttle.check('login', 'source-4999').allowed).toBe(true)
    failRepeatedly(throttle, 2, 'source-4999')
    expect(throttle.check('login', 'source-4999').allowed).toBe(false)
  })
})
