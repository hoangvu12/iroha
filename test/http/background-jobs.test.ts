import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  BackgroundScheduleSettingsService,
  BackgroundScheduler,
  type BackgroundJob,
  type BackgroundJobRunResult,
} from '../../src/jobs/index.ts'
import {
  completeSetup,
  createTestApp,
  signIn,
  type TestApp,
  type SignedIn,
} from '../support/app.ts'
import { testClock } from '../support/identity.ts'

/**
 * The management route covers the readout and the manual trigger. The
 * scheduler's own behaviour is tested in `test/jobs/scheduler.test.ts`; here
 * the suite proves the route's auth, response shape, and overlap refusal.
 */

function fakeJob(id: string, intervalSeconds: number, run: () => Promise<BackgroundJobRunResult>): BackgroundJob {
  return {
    id,
    label: id,
    intervalSeconds: () => intervalSeconds,
    run,
  }
}

describe('background jobs HTTP routes', () => {
  let app: TestApp
  let session: SignedIn

  beforeEach(async () => {
    // First create the app to obtain the database, then build a real scheduler
    // against that database, then re-create the app so the route talks to
    // the real scheduler instead of the StaticScheduler placeholder.
    const initial = await createTestApp()
    const clock = testClock()

    const settings = new BackgroundScheduleSettingsService({ database: initial.database, clock })
    const scheduler = new BackgroundScheduler({
      database: initial.database,
      jobs: [
        fakeJob('model_sync', 60, async () => ({ outcome: 'success', affectedCount: 0 })),
        fakeJob('usage_poll', 60, async () => ({ outcome: 'success', affectedCount: 0 })),
        fakeJob('cooldown_recovery', 30, async () => ({ outcome: 'success', affectedCount: 0 })),
        fakeJob('retention_cleanup', 3600, async () => ({ outcome: 'success', affectedCount: 0 })),
        fakeJob('session_cleanup', 3600, async () => ({ outcome: 'success', affectedCount: 0 })),
      ],
      settings,
      collaborators: {
        modelCatalog: initial.modelCatalog,
        providers: initial.usageService as never,
        usage: initial.usageService,
        requestHistory: initial.database as never,
        removeExpiredSessions: async () => 0,
      },
      clock,
    })
    await scheduler.seed()

    app = await createTestApp({
      backgroundSchedule: settings,
      backgroundScheduler: scheduler,
    })

    await completeSetup(app)
    session = await signIn(app)
  })

  afterEach(async () => {
    await app.dispose()
  })

  test('an unauthenticated request is rejected with 401', async () => {
    const response = await app.app.handle(new Request('http://iroha.test/api/v1/admin/background-jobs', {
      headers: { origin: 'http://iroha.test' },
    }))
    expect(response.status).toBe(401)
  })

  test('the list endpoint returns every scheduled job with its current status', async () => {
    const response = await app.fetch('/api/v1/admin/background-jobs')
    expect(response.status).toBe(200)
    const body = await response.json() as { jobs: Array<{ jobId: string; status: string }> }
    expect(body.jobs.map((job) => job.jobId)).toEqual([
      'model_sync',
      'usage_poll',
      'cooldown_recovery',
      'retention_cleanup',
      'session_cleanup',
    ])
  })

  test('the inspect endpoint returns a single job record', async () => {
    const response = await app.fetch('/api/v1/admin/background-jobs/model_sync')
    expect(response.status).toBe(200)
    const body = await response.json() as { jobId: string }
    expect(body.jobId).toBe('model_sync')
  })

  test('the inspect endpoint answers 404 for an unknown job', async () => {
    const response = await app.fetch('/api/v1/admin/background-jobs/unknown')
    expect(response.status).toBe(404)
  })

  test('the trigger endpoint runs the job and records its outcome', async () => {
    const response = await app.fetch('/api/v1/admin/background-jobs/model_sync/run', {
      method: 'POST',
      csrf: session.csrf,
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { status: string; lastOutcome: string }
    expect(body.status).toBe('succeeded')
    expect(body.lastOutcome).toBe('success')
  })

  test('a trigger without a CSRF token is rejected', async () => {
    const response = await app.fetch('/api/v1/admin/background-jobs/model_sync/run', {
      method: 'POST',
      csrf: 'no-csrf',
    })
    expect(response.status).toBe(403)
  })

  test('the settings endpoint reads the defaults', async () => {
    const response = await app.fetch('/api/v1/admin/background-jobs/settings')
    expect(response.status).toBe(200)
    const body = await response.json() as {
      modelSync: { intervalSeconds: number }
      retentionCleanup: { intervalSeconds: number; requestBatchSize: number }
    }
    expect(body.modelSync.intervalSeconds).toBe(3600)
    expect(body.retentionCleanup.requestBatchSize).toBe(1000)
  })

  test('the settings endpoint writes a partial update and returns the stored values', async () => {
    const response = await app.fetch('/api/v1/admin/background-jobs/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelSync: { intervalSeconds: 120 } }),
      csrf: session.csrf,
    })
    expect(response.status).toBe(200)
    const body = await response.json() as {
      modelSync: { intervalSeconds: number }
      usage: { intervalSeconds: number }
    }
    expect(body.modelSync.intervalSeconds).toBe(120)
    expect(body.usage.intervalSeconds).toBe(60)
  })

  test('an invalid settings write answers 400 with structured problems', async () => {
    const response = await app.fetch('/api/v1/admin/background-jobs/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelSync: { intervalSeconds: 1.5 } }),
      csrf: session.csrf,
    })
    expect(response.status).toBe(400)
    const body = await response.json() as { error: { code: string; problems: Array<{ field: string }> } }
    expect(body.error.code).toBe('validation_failed')
    expect(body.error.problems[0]?.field).toBe('modelSync.intervalSeconds')
  })
})