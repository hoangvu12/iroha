import type { Clock } from '../runtime/clock.ts'
import type { Database } from '../persistence/index.ts'

/**
 * The Owner's per-job background schedule settings.
 *
 * Every value is bounded so a typo in the settings store cannot make a job
 * fire once a millisecond orp once a year. Defaults are the same defaults the
 * scheduler uses when no setting has been written, so a fresh installation
 * behaves identically to one whose settings have been read once.
 *
 * Batches apply to cleanup jobs so a single run cannot monopolize the
 * database with a giant DELETE. The scheduler still calls the job on its
 * cadence; the runner's job is to do the work in pieces.
 */
export const DEFAULT_BACKGROUND_SCHEDULE: BackgroundScheduleSettings = {
  modelSync: {
    intervalSeconds: 3600,
  },
  usage: {
    intervalSeconds: 60,
  },
  cooldownRecovery: {
    intervalSeconds: 30,
  },
  retentionCleanup: {
    intervalSeconds: 3600,
    requestBatchSize: 1000,
  },
  sessionCleanup: {
    intervalSeconds: 3600,
    batchSize: 1000,
  },
}

export interface BackgroundScheduleSettings {
  readonly modelSync: { readonly intervalSeconds: number }
  readonly usage: { readonly intervalSeconds: number }
  readonly cooldownRecovery: { readonly intervalSeconds: number }
  readonly retentionCleanup: {
    readonly intervalSeconds: number
    readonly requestBatchSize: number
  }
  readonly sessionCleanup: {
    readonly intervalSeconds: number
    readonly batchSize: number
  }
}

const SETTINGS_KEY = 'background.schedule'

const MIN_INTERVAL_SECONDS = 1
const MAX_INTERVAL_SECONDS = 86_400 * 7
const MIN_BATCH_SIZE = 1
const MAX_BATCH_SIZE = 100_000

/**
 * Reads and writes the Owner's background schedule. The scheduler uses one
 * instance to refuse to fire on a misconfigured interval, and to expose the
 * current settings to the management route.
 */
export class BackgroundScheduleSettingsService {
  readonly #database: Database
  /** The last-fetched settings; `null` means the cache has not been primed yet. */
  #cached: BackgroundScheduleSettings | null = null

  constructor(options: { readonly database: Database; readonly clock?: Clock }) {
    this.#database = options.database
  }

  /** Reads the schedule settings, returning defaults for a fresh installation. */
  async read(): Promise<BackgroundScheduleSettings> {
    if (this.#cached !== null) return this.#cached
    this.#cached = await this.#loadFromSettings()
    return this.#cached
  }

  /**
   * Atomically writes the schedule, dropping fields the Owner did not supply
   * so partial writes never leave a stale value behind. Returns the stored
   * values so the management route can echo them.
   */
  async write(patch: unknown): Promise<BackgroundScheduleSettings> {
    const parsed = parseSettingsPatch(patch)
    if ('problems' in parsed) {
      throw new SettingsValidationError(parsed.problems)
    }

    const next = normalizeSettings({ ...DEFAULT_BACKGROUND_SCHEDULE, ...parsed })
    const stored = await this.#database.settings.put(SETTINGS_KEY, next)
    const value = sanitizeStored(stored.value)
    this.#cached = value
    return value
  }

  /** Forces the next read to come from the database. Tests use it after a direct write. */
  invalidate(): void {
    this.#cached = null
  }

  async #loadFromSettings(): Promise<BackgroundScheduleSettings> {
    const stored = await this.#database.settings.get(SETTINGS_KEY)
    return sanitizeStored(stored?.value)
  }
}

/** Thrown when a write arrives with an invalid body. */
export class SettingsValidationError extends Error {
  readonly problems: readonly { readonly field: string; readonly message: string } []

  constructor(problems: readonly { readonly field: string; readonly message: string } []) {
    super('Background schedule values are not acceptable.')
    this.name = 'SettingsValidationError'
    this.problems = problems
  }
}

interface SettingsParseSuccess {
  readonly modelSync: { intervalSeconds: number }
  readonly usage: { intervalSeconds: number }
  readonly cooldownRecovery: { intervalSeconds: number }
  readonly retentionCleanup: { intervalSeconds: number; requestBatchSize: number }
  readonly sessionCleanup: { intervalSeconds: number; batchSize: number }
}

type RetentionCleanupParse = {
  intervalSeconds: number
  requestBatchSize?: number
  batchSize?: number
}

type SessionCleanupParse = {
  intervalSeconds: number
  requestBatchSize?: number
  batchSize?: number
}

function parseSettingsPatch(input: unknown): SettingsParseSuccess | { readonly problems: readonly { field: string; message: string } [] } {
  if (input === undefined || input === null) {
    return { problems: [{ field: 'settings', message: 'is required' }] }
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { problems: [{ field: 'settings', message: 'must be an object' }] }
  }

  const record = input as Record<string, unknown>
  const problems: { field: string; message: string } [] = []
  const next: Record<string, unknown> = {}

  next.modelSync = parseIntervalObject(record.modelSync, 'modelSync', problems)
  next.usage = parseIntervalObject(record.usage, 'usage', problems)
  next.cooldownRecovery = parseIntervalObject(record.cooldownRecovery, 'cooldownRecovery', problems)
  next.retentionCleanup = parseRetentionOrInterval(
    record.retentionCleanup,
    'retentionCleanup',
    problems,
  )
  next.sessionCleanup = parseRetentionOrInterval(
    record.sessionCleanup,
    'sessionCleanup',
    problems,
  )

  if (problems.length > 0) return { problems }
  return next as unknown as SettingsParseSuccess
}

function parseIntervalObject(
  value: unknown,
  field: string,
  problems: { field: string; message: string } [],
): { intervalSeconds: number } {
  if (value === undefined || value === null) {
    return { intervalSeconds: DEFAULT_BACKGROUND_SCHEDULE[field as keyof BackgroundScheduleSettings].intervalSeconds }
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    problems.push({ field, message: 'must be an object' })
    return { intervalSeconds: 0 }
  }
  const record = value as Record<string, unknown>
  const out: { intervalSeconds: number } = {
    intervalSeconds: DEFAULT_BACKGROUND_SCHEDULE[field as keyof BackgroundScheduleSettings].intervalSeconds,
  }
  if (record.intervalSeconds !== undefined) {
    out.intervalSeconds = readIntervalSeconds(record.intervalSeconds, `${field}.intervalSeconds`, problems)
  }
  return out
}

function parseRetentionOrInterval(
  value: unknown,
  field: 'retentionCleanup' | 'sessionCleanup',
  problems: { field: string; message: string } [],
): RetentionCleanupParse | SessionCleanupParse {
  if (value === undefined || value === null) {
    if (field === 'retentionCleanup') {
      return { intervalSeconds: DEFAULT_BACKGROUND_SCHEDULE.retentionCleanup.intervalSeconds }
    }
    return { intervalSeconds: DEFAULT_BACKGROUND_SCHEDULE.sessionCleanup.intervalSeconds }
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    problems.push({ field, message: 'must be an object' })
    if (field === 'retentionCleanup') {
      return { intervalSeconds: 0 }
    }
    return { intervalSeconds: 0 }
  }
  const record = value as Record<string, unknown>
  let intervalSeconds = field === 'retentionCleanup'
    ? DEFAULT_BACKGROUND_SCHEDULE.retentionCleanup.intervalSeconds
    : DEFAULT_BACKGROUND_SCHEDULE.sessionCleanup.intervalSeconds
  if (record.intervalSeconds !== undefined) {
    intervalSeconds = readIntervalSeconds(record.intervalSeconds, `${field}.intervalSeconds`, problems)
  }
  if (field === 'retentionCleanup') {
    const out: RetentionCleanupParse = { intervalSeconds }
    if (record.requestBatchSize !== undefined) {
      out.requestBatchSize = readBatchSize(
        record.requestBatchSize,
        `${field}.requestBatchSize`,
        problems,
      )
    }
    return out
  }
  const out: SessionCleanupParse = { intervalSeconds }
  if (record.batchSize !== undefined) {
    out.batchSize = readBatchSize(record.batchSize, `${field}.batchSize`, problems)
  }
  return out
}

function readIntervalSeconds(
  value: unknown,
  field: string,
  problems: { field: string; message: string } [],
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    problems.push({ field, message: 'must be an integer' })
    return MIN_INTERVAL_SECONDS
  }
  // Out-of-range values are clamped rather than rejected; the Owner-facing
  // write path stores the clamped bytes so a typo cannot make the scheduler
  // fire every millisecond.
  return Math.min(MAX_INTERVAL_SECONDS, Math.max(MIN_INTERVAL_SECONDS, value))
}

function readBatchSize(
  value: unknown,
  field: string,
  problems: { field: string; message: string } [],
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    problems.push({ field, message: 'must be an integer' })
    return MIN_BATCH_SIZE
  }
  return Math.min(MAX_BATCH_SIZE, Math.max(MIN_BATCH_SIZE, value))
}

function normalizeSettings(value: BackgroundScheduleSettings): BackgroundScheduleSettings {
  return {
    modelSync: { intervalSeconds: clamp(value.modelSync.intervalSeconds) },
    usage: { intervalSeconds: clamp(value.usage.intervalSeconds) },
    cooldownRecovery: { intervalSeconds: clamp(value.cooldownRecovery.intervalSeconds) },
    retentionCleanup: {
      intervalSeconds: clamp(value.retentionCleanup.intervalSeconds),
      requestBatchSize: clampBatch(value.retentionCleanup.requestBatchSize),
    },
    sessionCleanup: {
      intervalSeconds: clamp(value.sessionCleanup.intervalSeconds),
      batchSize: clampBatch(value.sessionCleanup.batchSize),
    },
  }
}

function clamp(value: number): number {
  return Math.min(MAX_INTERVAL_SECONDS, Math.max(MIN_INTERVAL_SECONDS, Math.floor(value)))
}

function clampBatch(value: number): number {
  return Math.min(MAX_BATCH_SIZE, Math.max(MIN_BATCH_SIZE, Math.floor(value)))
}

function sanitizeStored(value: unknown): BackgroundScheduleSettings {
  if (value === null || typeof value !== 'object') {
    return DEFAULT_BACKGROUND_SCHEDULE
  }
  const record = value as Record<string, unknown>
  return {
    modelSync: parseSettingsGroup(record.modelSync, 'modelSync'),
    usage: parseSettingsGroup(record.usage, 'usage'),
    cooldownRecovery: parseSettingsGroup(record.cooldownRecovery, 'cooldownRecovery'),
    retentionCleanup: parseRetentionStored(record.retentionCleanup, 'retentionCleanup') as BackgroundScheduleSettings['retentionCleanup'],
    sessionCleanup: parseRetentionStored(record.sessionCleanup, 'sessionCleanup') as BackgroundScheduleSettings['sessionCleanup'],
  }
}

function parseSettingsGroup(
  raw: unknown,
  field: 'modelSync' | 'usage' | 'cooldownRecovery',
): { intervalSeconds: number } {
  if (raw === null || typeof raw !== 'object') {
    return { intervalSeconds: DEFAULT_BACKGROUND_SCHEDULE[field].intervalSeconds }
  }
  const record = raw as Record<string, unknown>
  const intervalSeconds = typeof record.intervalSeconds === 'number'
    ? clamp(record.intervalSeconds)
    : DEFAULT_BACKGROUND_SCHEDULE[field].intervalSeconds
  return { intervalSeconds }
}

function parseRetentionStored(
  raw: unknown,
  field: 'retentionCleanup' | 'sessionCleanup',
): BackgroundScheduleSettings['retentionCleanup'] | BackgroundScheduleSettings['sessionCleanup'] {
  if (field === 'retentionCleanup') {
    const defaults = DEFAULT_BACKGROUND_SCHEDULE.retentionCleanup
    if (raw === null || typeof raw !== 'object') {
      return { intervalSeconds: defaults.intervalSeconds, requestBatchSize: defaults.requestBatchSize }
    }
    const record = raw as Record<string, unknown>
    const intervalSeconds = typeof record.intervalSeconds === 'number'
      ? clamp(record.intervalSeconds)
      : defaults.intervalSeconds
    const requestBatchSize = typeof record.requestBatchSize === 'number'
      ? clampBatch(record.requestBatchSize)
      : defaults.requestBatchSize
    return { intervalSeconds, requestBatchSize }
  }
  const defaults = DEFAULT_BACKGROUND_SCHEDULE.sessionCleanup
  if (raw === null || typeof raw !== 'object') {
    return { intervalSeconds: defaults.intervalSeconds, batchSize: defaults.batchSize }
  }
  const record = raw as Record<string, unknown>
  const intervalSeconds = typeof record.intervalSeconds === 'number'
    ? clamp(record.intervalSeconds)
    : defaults.intervalSeconds
  const batchSize = typeof record.batchSize === 'number'
    ? clampBatch(record.batchSize)
    : defaults.batchSize
  return { intervalSeconds, batchSize }
}
