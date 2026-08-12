import { describe, expect, test } from 'bun:test'
import { installShutdownSignalHandlers } from '../../src/runtime/signals.ts'

class SignalTarget {
  readonly listeners = new Map<string, () => void>()

  once(signal: string, listener: () => void): this {
    this.listeners.set(signal, listener)
    return this
  }

  removeListener(signal: string): void {
    this.listeners.delete(signal)
  }

  emit(signal: string): void {
    this.listeners.get(signal)?.()
  }
}

describe('shutdown signal handlers', () => {
  test('registers one graceful stop handler for each hosting signal', async () => {
    const target = new SignalTarget()
    let stops = 0
    const cleanup = installShutdownSignalHandlers(
      { stop: async () => { stops += 1 } },
      { register: target, exit: () => undefined },
    )
    expect(target.listeners.size).toBe(2)

    target.emit('SIGTERM')
    target.emit('SIGINT')
    await Bun.sleep(0)

    expect(stops).toBe(1)
    cleanup()
    target.emit('SIGTERM')
    expect(stops).toBe(1)
  })
})
