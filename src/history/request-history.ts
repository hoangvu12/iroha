import type { Clock } from '../runtime/clock.ts'
import { systemClock } from '../runtime/clock.ts'
import {
  type AttemptOutcome,
  type Database,
  type RequestAttemptRecord,
  type RequestEventRecord,
  type RequestHistoryListOptions,
  type RequestHistoryListResult,
  type RequestOutcome,
} from '../persistence/index.ts'

/** The settings key holding the retention configuration. */
export const REQUEST_HISTORY_SETTING_KEY = 'requestHistory.retention'

/** How long a request event lives before retention prunes it. */
export interface RequestHistoryRetention {
  /**
   * Days an event is kept. Zero (or any non-positive value) disables storage
   * entirely: no event row is written, no attempt row is written, and the
   * Owner's request list is empty by construction.
   */
  readonly days: number
}

export const DEFAULT_RETENTION_DAYS = 30

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * One attempt Iroha is about to make: which Upstream Key, when it started,
 * and a `finalize` callback that the inference loop calls when the upstream
 * answer arrives. The callback writes the attempt's terminal row so the
 * Owner can see exactly which key served which status and why.
 */
export interface InFlightAttempt {
  readonly id: number
  readonly attemptNumber: number
  readonly startedAt: Date
  readonly keyId: string | null
  finalize(outcome: {
    readonly status: number | null
    readonly outcome: AttemptOutcome
    readonly errorCode: string | null
    readonly retryAfterSeconds: number | null
    readonly at: Date
  }): Promise<void>
}

/**
 * One inference call Iroha is recording: the Owner-facing row plus a queue
 * of attempts the loop will close as it goes. `finalize` writes the final
 * `request_events` row with its terminal status and token usage; `cancel`
 * records a failure outcome with no usage when the call ends early.
 */
export interface InFlightRequest {
  readonly id: string
  readonly connectionId: string
  readonly model: string
  readonly gatewayKeyId: string | null
  readonly startedAt: Date
  startAttempt(input: {
    readonly attemptNumber: number
    readonly keyId: string | null
    readonly at: Date
  }): Promise<InFlightAttempt>
  finalize(outcome: {
    readonly status: number
    readonly outcome: RequestOutcome
    readonly isStreaming: boolean
    readonly latencyMs: number
    readonly keyId: string | null
    readonly promptTokens: number | null
    readonly completionTokens: number | null
    readonly totalTokens: number | null
    readonly errorCode: string | null
  }): Promise<void>
  /** Records a `no_eligible_key` outcome without ever opening an attempt. */
  recordSkip(errorCode: string, at: Date): Promise<void>
}

export interface RequestHistoryServiceOptions {
  readonly database: Database
  readonly clock?: Clock
}

/**
 * The Owner's request history and audit feed.
 *
 * The service is the seam the inference route asks for an in-flight record,
 * and the seam the Owner UI asks for filtered, paginated reads. Retention is
 * read on every call so a UI toggle takes effect on the next request without
 * a restart. When retention is disabled the service hands back a recording
 * object that silently no-ops: inference must keep working even when the
 * Owner has turned history off.
 */
export class RequestHistoryService {
  readonly #database: Database
  readonly #clock: Clock

  constructor(options: RequestHistoryServiceOptions) {
    this.#database = options.database
    this.#clock = options.clock ?? systemClock
  }

/**
 * Starts recording one inference call. Returns a recorder whose `startAttempt`
 * and `finalize` calls write to the database; when history is disabled
 * they return immediately without touching anything.
 *
 * The event row is written lazily, on the first `startAttempt` call: until
 * then the connection might be missing, archived, or disabled and an INSERT
 * would fail on the foreign key. `finalize` and `recordSkip` both upsert
 * the same event row with their terminal values so the Owner sees one row
 * per request regardless of how many attempts happened.
 */
  beginRequest(input: {
    readonly id: string
    readonly connectionId: string
    readonly model: string
    readonly gatewayKeyId: string | null
  }): InFlightRequest {
    const startedAt = this.#clock.now()
    const repository = this.#database.requestHistory

    if (!this.#retentionEnabled()) {
      return noopRecorder(input.id)
    }

    const self = this
    let eventWritten = false

    const writeEventOnce = async (overrides: Partial<RequestEventRecord>): Promise<void> => {
      if (!self.#retentionEnabled()) return
      const event: RequestEventRecord = {
        id: input.id,
        occurredAt: startedAt,
        connectionId: input.connectionId,
        model: input.model,
        gatewayKeyId: input.gatewayKeyId,
        keyId: null,
        status: 0,
        outcome: 'failure',
        latencyMs: 0,
        isStreaming: false,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        errorCode: null,
        ...overrides,
      }
      try {
        await repository.recordEvent(event)
      } catch {
        // The connection may have vanished between authorization and the
        // first attempt; a missing parent is not worth aborting the call.
      }
      eventWritten = true
    }

    return {
      id: input.id,
      connectionId: input.connectionId,
      model: input.model,
      gatewayKeyId: input.gatewayKeyId,
      startedAt,

      async startAttempt({ attemptNumber, keyId, at }) {
        if (!self.#retentionEnabled()) {
          return noopAttempt({ attemptNumber, keyId, startedAt: at })
        }
        if (!eventWritten) {
          await writeEventOnce({})
        }
        const recorded = await repository.recordAttempt({
          requestId: input.id,
          attemptNumber,
          keyId,
          startedAt: at,
          completedAt: null,
          status: null,
          outcome: 'failure',
          errorCode: null,
          retryAfterSeconds: null,
        })

        return {
          id: recorded.id,
          attemptNumber,
          startedAt: at,
          keyId,
          async finalize({ status, outcome, errorCode, retryAfterSeconds, at: completedAt }) {
            await repository.updateAttempt(recorded.id, {
              completedAt,
              status,
              outcome,
              errorCode,
              retryAfterSeconds,
            })
          },
        }
      },

      async finalize(outcome) {
        if (!self.#retentionEnabled()) return
        const event: RequestEventRecord = {
          id: input.id,
          occurredAt: self.#clock.now(),
          connectionId: input.connectionId,
          model: input.model,
          gatewayKeyId: input.gatewayKeyId,
          keyId: outcome.keyId ?? null,
          status: outcome.status,
          outcome: outcome.outcome,
          latencyMs: outcome.latencyMs,
          isStreaming: outcome.isStreaming,
          promptTokens: outcome.promptTokens,
          completionTokens: outcome.completionTokens,
          totalTokens: outcome.totalTokens,
          errorCode: outcome.errorCode,
        }
        try {
          await repository.recordEvent(event)
        } catch {
          // The connection may have been purged mid-call. The attempt rows
          // already carry the Owner-visible retry trail; missing the event
          // row is a worse failure than the inference itself.
        }
      },

      async recordSkip(errorCode, at) {
        if (!self.#retentionEnabled()) return
        if (eventWritten) return
        const event: RequestEventRecord = {
          id: input.id,
          occurredAt: at,
          connectionId: input.connectionId,
          model: input.model,
          gatewayKeyId: input.gatewayKeyId,
          keyId: null,
          status: 503,
          outcome: 'failure',
          latencyMs: at.getTime() - startedAt.getTime(),
          isStreaming: false,
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          errorCode,
        }
        try {
          await repository.recordEvent(event)
        } catch {
          // FK failed because the connection is gone.
          return
        }
        eventWritten = true
        try {
          await repository.recordAttempt({
            requestId: input.id,
            attemptNumber: 1,
            keyId: null,
            startedAt: at,
            completedAt: at,
            status: null,
            outcome: 'skipped',
            errorCode,
            retryAfterSeconds: null,
          })
        } catch {
          // FK failed; the event row alone is still useful.
        }
      },
    }
  }

  async listEvents(options?: RequestHistoryListOptions): Promise<RequestHistoryListResult> {
    return await this.#database.requestHistory.listEvents(options)
  }

  async getEvent(id: string): Promise<RequestEventRecord | null> {
    return await this.#database.requestHistory.getEvent(id)
  }

  async getAttempts(requestId: string): Promise<readonly RequestAttemptRecord[]> {
    return await this.#database.requestHistory.getAttempts(requestId)
  }

  /**
   * Drops events older than the retention window. Called opportunistically
   * by background work and at the end of every list call so a long-lived
   * installation never accumulates rows the Owner has already told it to
   * forget.
   */
  async prune(): Promise<number> {
    if (!this.#retentionEnabled()) return 0
    const days = await this.#effectiveDays()
    if (days <= 0) return 0
    const cutoff = new Date(this.#clock.now().getTime() - days * MS_PER_DAY)
    return await this.#database.requestHistory.pruneEvents(cutoff)
  }

  /**
   * Drops at most `limit` events older than the retention window, returning
   * the number actually removed. The bounded form is what the background
   * retention job calls: it cooperates with the database so a single tick
   * cannot monopolize the connection with one giant DELETE.
   */
  async pruneBounded(limit: number): Promise<number> {
    if (!this.#retentionEnabled()) return 0
    const days = await this.#effectiveDays()
    if (days <= 0) return 0
    const cutoff = new Date(this.#clock.now().getTime() - days * MS_PER_DAY)
    return await this.#database.requestHistory.pruneEventsBounded(cutoff, limit)
  }

  /** Reads the configured retention window, applying the default when unset. */
  async readRetention(): Promise<RequestHistoryRetention> {
    return await this.#readRetentionSetting()
  }

  /**
   * Writes the retention window. Zero days means "do not store history at
   * all"; the next `beginRequest` returns a no-op recorder so the Owner can
   * turn history off without restarting.
   */
  async writeRetention(value: RequestHistoryRetention): Promise<RequestHistoryRetention> {
    const stored: RequestHistoryRetention = { days: Math.max(0, Math.floor(value.days)) }
    const setting = await this.#database.settings.put(REQUEST_HISTORY_SETTING_KEY, stored)
    this.#cachedRetentionDays = stored.days
    return (setting.value as RequestHistoryRetention) ?? stored
  }

  #retentionEnabled(): boolean {
    return this.#cachedRetentionDays === null ? true : this.#cachedRetentionDays > 0
  }

  async #effectiveDays(): Promise<number> {
    if (this.#cachedRetentionDays !== null) return this.#cachedRetentionDays
    const retention = await this.#readRetentionSetting()
    return retention.days
  }

  #cachedRetentionDays: number | null = null

  async #readRetentionSetting(): Promise<RequestHistoryRetention> {
    const stored = await this.#database.settings.get(REQUEST_HISTORY_SETTING_KEY)
    const raw = stored?.value
    if (
      raw !== null &&
      typeof raw === 'object' &&
      raw !== null &&
      'days' in raw &&
      typeof (raw as { days: unknown }).days === 'number'
    ) {
      const days = Math.max(0, Math.floor((raw as { days: number }).days))
      this.#cachedRetentionDays = days
      return { days }
    }
    this.#cachedRetentionDays = DEFAULT_RETENTION_DAYS
    return { days: DEFAULT_RETENTION_DAYS }
  }
}

function noopRecorder(id: string): InFlightRequest {
  return {
    id,
    connectionId: '',
    model: '',
    gatewayKeyId: null,
    startedAt: new Date(0),
    async startAttempt({ attemptNumber, keyId, at }) {
      return noopAttempt({ attemptNumber, keyId, startedAt: at })
    },
    async finalize() {
      // History is off; the recorder is a no-op.
    },
    async recordSkip() {
      // History is off; the recorder is a no-op.
    },
  }
}

function noopAttempt(input: {
  readonly attemptNumber: number
  readonly keyId: string | null
  readonly startedAt: Date
}): InFlightAttempt {
  return {
    id: 0,
    attemptNumber: input.attemptNumber,
    startedAt: input.startedAt,
    keyId: input.keyId,
    async finalize() {
      // History is off; the recorder is a no-op.
    },
  }
}