export interface BackgroundJobView {
  readonly jobId: string
  readonly label: string
  readonly status: 'idle' | 'running' | 'succeeded' | 'failed'
  readonly lastStartedAt: string | null
  readonly lastCompletedAt: string | null
  readonly lastOutcome: 'success' | 'failure' | null
  readonly lastErrorCode: string | null
  readonly lastErrorMessage: string | null
  readonly lastDurationMs: number | null
  readonly lastAffectedCount: number | null
  readonly updatedAt: string
}

export interface BackgroundJobList {
  readonly jobs: readonly BackgroundJobView[]
}

export interface BackgroundScheduleView {
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

export class BackgroundError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'BackgroundError'
    this.code = code
  }
}

export async function fetchBackgroundJobs(
  signal?: AbortSignal,
): Promise<readonly BackgroundJobView[]> {
  const body = await request<BackgroundJobList>('GET', '/', { signal })
  return body.jobs
}

export async function triggerBackgroundJob(
  jobId: string,
  csrfToken: string,
): Promise<BackgroundJobView> {
  return await request<BackgroundJobView>('POST', `/${encodeURIComponent(jobId)}/run`, { csrfToken })
}

export async function fetchBackgroundSchedule(signal?: AbortSignal): Promise<BackgroundScheduleView> {
  return await request<BackgroundScheduleView>('GET', '/settings', { signal })
}

export async function updateBackgroundSchedule(
  schedule: BackgroundScheduleView,
  csrfToken: string,
): Promise<BackgroundScheduleView> {
  return await request<BackgroundScheduleView>('PUT', '/settings', { body: schedule, csrfToken })
}

async function request<T = unknown>(
  method: string,
  path: string,
  options: { body?: unknown; csrfToken?: string; signal?: AbortSignal } = {},
): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api/v1/admin/background-jobs${path}`, {
      method,
      credentials: 'same-origin',
      ...(options.signal ? { signal: options.signal } : {}),
      headers: {
        accept: 'application/json',
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.csrfToken === undefined ? {} : { 'x-iroha-csrf': options.csrfToken }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
  } catch {
    throw new BackgroundError('unreachable', 'Iroha did not answer. Check that the gateway is running.')
  }

  if (response.status === 204) return undefined as T

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) throw toError(payload)
  return payload as T
}

function toError(payload: unknown): BackgroundError {
  const error = (payload as { error?: { code?: unknown; message?: unknown } })?.error
  return new BackgroundError(
    typeof error?.code === 'string' ? error.code : 'request_failed',
    typeof error?.message === 'string' ? error.message : 'That request could not be completed.',
  )
}