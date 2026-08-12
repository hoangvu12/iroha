import { describe, expect, test } from 'bun:test'
import { ShutdownController } from '../../src/runtime/shutdown.ts'
import { fakeTimer, type FakeTimer } from '../support/timer.ts'

function controllerWith(timer: FakeTimer, graceMs: number) {
  return new ShutdownController({ graceMs, timer })
}

describe('shutdown lifecycle', () => {
  test('rejects new inference once draining begins', async () => {
    const timer = fakeTimer()
    const shutdown = controllerWith(timer, 1_000)

    await shutdown.drain()

    expect(shutdown.beginInference(new AbortController().signal)).toBeNull()
  })

  test('drain resolves immediately when no inference is active', async () => {
    const timer = fakeTimer()
    const shutdown = controllerWith(timer, 1_000)

    await shutdown.drain()

    expect(timer.elapsedMs).toBe(0)
  })

  test('aborts outstanding upstream work only after the grace period', async () => {
    const timer = fakeTimer()
    const shutdown = controllerWith(timer, 250)
    const caller = new AbortController()
    const inference = shutdown.beginInference(caller.signal)
    if (inference === null) throw new Error('expected inference to be accepted')

    let drained = false
    const draining = shutdown.drain().then(() => {
      drained = true
    })

    timer.advance(249)
    timer.flush()
    expect(drained).toBe(false)
    expect(inference.signal.aborted).toBe(false)

    timer.advance(1)
    timer.flush()
    expect(drained).toBe(false)
    expect(inference.signal.aborted).toBe(true)

    inference.finish()
    await draining
    expect(drained).toBe(true)
  })
})
