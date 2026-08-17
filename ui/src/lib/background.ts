import { request } from './api-client.ts'

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

const BACKGROUND_JOBS = '/background-jobs'

export async function fetchBackgroundJobs(
  signal?: AbortSignal,
): Promise<readonly BackgroundJobView[]> {
  const body = await request<BackgroundJobList>('GET', `${BACKGROUND_JOBS}/`, { signal })
  return body.jobs
}

export async function triggerBackgroundJob(
  jobId: string,
  csrfToken: string,
): Promise<BackgroundJobView> {
  return await request<BackgroundJobView>(
    'POST',
    `${BACKGROUND_JOBS}/${encodeURIComponent(jobId)}/run`,
    { csrfToken },
  )
}

export async function fetchBackgroundSchedule(signal?: AbortSignal): Promise<BackgroundScheduleView> {
  return await request<BackgroundScheduleView>('GET', `${BACKGROUND_JOBS}/settings`, { signal })
}

export async function updateBackgroundSchedule(
  schedule: BackgroundScheduleView,
  csrfToken: string,
): Promise<BackgroundScheduleView> {
  return await request<BackgroundScheduleView>('PUT', `${BACKGROUND_JOBS}/settings`, {
    body: schedule,
    csrfToken,
  })
}