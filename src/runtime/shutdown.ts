import { systemTimer, type Timer } from './timer.ts'

export interface InferenceActivity {
  readonly signal: AbortSignal
  abort(): void
  finish(): void
}

export class ShutdownController {
  readonly #timer: Timer
  readonly #graceMs: number
  readonly #inference = new Set<InferenceActivity>()
  #draining = false
  #deadline: (() => void) | null = null
  #deadlineCancel: (() => void) | null = null

  constructor(options: { readonly graceMs: number; readonly timer?: Timer }) {
    this.#timer = options.timer ?? systemTimer
    this.#graceMs = Math.max(0, options.graceMs)
  }

  beginInference(callerSignal: AbortSignal): InferenceActivity | null {
    if (this.#draining) return null

    const downstream = new AbortController()
    const relay = () => downstream.abort()
    if (callerSignal.aborted) relay()
    callerSignal.addEventListener('abort', relay, { once: true })
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      callerSignal.removeEventListener('abort', relay)
      this.#finish(inference)
    }

    const inference: InferenceActivity = {
      signal: downstream.signal,
      abort: relay,
      finish,
    }

    this.#inference.add(inference)
    return inference
  }

  async drain(options: { readonly onDeadline?: () => void | Promise<void> } = {}): Promise<void> {
    if (!this.#draining) this.#draining = true
    if (this.#inference.size === 0) {
      this.#cancelDeadline()
      return
    }

    if (this.#graceMs === 0) {
      this.#abortActiveInference()
    } else if (this.#deadline === null) {
      await this.#waitForDeadline(options.onDeadline)
    }

    if (this.#inference.size > 0) this.#abortActiveInference()
    await this.#waitForIdle()
  }

  #finish(inference: InferenceActivity): void {
    if (!this.#inference.delete(inference)) return
    if (this.#inference.size === 0) this.#completeDeadline()
    this.#resolveIdleWaiters()
  }

  #abortActiveInference(): void {
    for (const inference of [...this.#inference]) inference.abort()
  }

  #waitForDeadline(onDeadline: (() => void | Promise<void>) | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = async () => {
        this.#deadline = null
        this.#deadlineCancel?.()
        this.#deadlineCancel = null
        this.#abortActiveInference()
        try {
          await onDeadline?.()
          resolve()
        } catch (error) {
          reject(error)
        }
      }
      this.#deadline = deadline
      this.#deadlineCancel = this.#timer.set(deadline, this.#graceMs)
    })
  }

  #completeDeadline(): void {
    const deadline = this.#deadline
    this.#deadline = null
    deadline?.()
  }

  #cancelDeadline(): void {
    this.#completeDeadline()
    this.#deadlineCancel = null
  }

  #waitForIdle(): Promise<void> {
    if (this.#inference.size === 0) return Promise.resolve()
    return new Promise((resolve) => {
      const waiter = () => {
        this.#idleWaiters.delete(waiter)
        resolve()
      }
      this.#idleWaiters.add(waiter)
    })
  }

  readonly #idleWaiters = new Set<() => void>()

  #resolveIdleWaiters(): void {
    for (const waiter of [...this.#idleWaiters]) waiter()
  }
}
