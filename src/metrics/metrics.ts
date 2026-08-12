import type { Database, UpstreamKeyHealth } from '../persistence/index.ts'

export type MetricsSettings = { readonly enabled: boolean }

export type KeyHealthCounts = Readonly<Record<UpstreamKeyHealth, number>>

export const ALL_KEY_HEALTH_STATES: readonly UpstreamKeyHealth[] = [
  'unverified',
  'active',
  'cooling_down',
  'invalid_authentication',
  'exhausted',
  'disabled',
]

const DURATION_BUCKETS_SECONDS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, Number.POSITIVE_INFINITY] as const

export class MetricsCollector {
  readonly #now: () => number
  readonly #starts = new WeakMap<Request, number>()
  #successes = 0
  #failures = 0
  #http4xx = 0
  #http5xx = 0
  #network = 0
  #otherFailures = 0
  #durationCount = 0
  #durationSum = 0
  readonly #durationBuckets = new Map<number, number>()
  #retries = 0

  constructor(options: { readonly now?: () => number } = {}) {
    this.#now = options.now ?? (() => performance.now())
    for (const bucket of DURATION_BUCKETS_SECONDS) this.#durationBuckets.set(bucket, 0)
  }

  begin(request: Request): void {
    this.#starts.set(request, this.#now())
  }

  finish(request: Request, status: number | null): void {
    const started = this.#starts.get(request)
    if (started === undefined) return
    this.#starts.delete(request)

    const durationMs = Math.max(0, this.#now() - started)
    this.#durationCount += 1
    this.#durationSum += durationMs
    for (const bucket of DURATION_BUCKETS_SECONDS) {
      if (durationMs / 1000 <= bucket) this.#durationBuckets.set(bucket, (this.#durationBuckets.get(bucket) ?? 0) + 1)
    }

    if (status !== null && status >= 200 && status < 400) {
      this.#successes += 1
      return
    }

    this.#failures += 1
    if (status === null) this.#network += 1
    else if (status >= 500) this.#http5xx += 1
    else if (status >= 400) this.#http4xx += 1
    else this.#otherFailures += 1
  }

  recordRetry(): void {
    this.#retries += 1
  }

  render(keyHealthCounts: KeyHealthCounts): string {
    const lines: string[] = []
    lines.push('# HELP iroha_requests_total Number of completed inference requests.', '# TYPE iroha_requests_total counter')
    lines.push(`iroha_requests_total{outcome="success"} ${this.#successes}`)
    lines.push(`iroha_requests_total{outcome="failure"} ${this.#failures}`)
    lines.push('# HELP iroha_request_failures_total Number of failed inference requests by bounded failure kind.', '# TYPE iroha_request_failures_total counter')
    lines.push(`iroha_request_failures_total{kind="http_4xx"} ${this.#http4xx}`)
    lines.push(`iroha_request_failures_total{kind="http_5xx"} ${this.#http5xx}`)
    lines.push(`iroha_request_failures_total{kind="network"} ${this.#network}`)
    lines.push(`iroha_request_failures_total{kind="other"} ${this.#otherFailures}`)
    lines.push('# HELP iroha_request_duration_seconds Inference request duration.', '# TYPE iroha_request_duration_seconds histogram')
    let previous = 0
    for (const bucket of DURATION_BUCKETS_SECONDS) {
      const cumulative = this.#durationBuckets.get(bucket) ?? 0
      const label = Number.isFinite(bucket) ? String(bucket) : '+Inf'
      lines.push(`iroha_request_duration_seconds_bucket{le="${label}"} ${Math.max(previous, cumulative)}`)
      previous = Math.max(previous, cumulative)
    }
    lines.push(`iroha_request_duration_seconds_sum ${this.#durationSum / 1000}`, `iroha_request_duration_seconds_count ${this.#durationCount}`)
    lines.push('# HELP iroha_retries_total Number of inference retry attempts.', '# TYPE iroha_retries_total counter', `iroha_retries_total ${this.#retries}`)
    lines.push('# HELP iroha_upstream_key_health Number of Upstream Keys by bounded Key Health state.', '# TYPE iroha_upstream_key_health gauge')
    for (const health of ALL_KEY_HEALTH_STATES) {
      lines.push(`iroha_upstream_key_health{health="${health}"} ${keyHealthCounts[health]}`)
    }
    return `${lines.join('\n')}\n`
  }
}

export class MetricsSettingsService {
  readonly #database: Database

  constructor(database: Database) {
    this.#database = database
  }

  async read(): Promise<MetricsSettings> {
    const stored = await this.#database.settings.get('observability.metrics')
    const value = stored?.value
    return { enabled: typeof value === 'object' && value !== null && (value as { enabled?: unknown }).enabled === true }
  }

  async write(input: unknown): Promise<MetricsSettings> {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new MetricsSettingsValidationError('enabled must be a boolean')
    }
    const value = input as { readonly enabled?: unknown }
    if (value.enabled !== true && value.enabled !== false) {
      throw new MetricsSettingsValidationError('enabled must be a boolean')
    }
    const settings: MetricsSettings = { enabled: value.enabled }
    await this.#database.settings.put('observability.metrics', settings)
    return settings
  }
}

export class MetricsSettingsValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MetricsSettingsValidationError'
  }
}
