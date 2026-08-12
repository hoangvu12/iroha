import type { BackgroundJobRecord, Database } from '../persistence/index.ts'

/**
 * The scheduler-management surface the management route reaches for. The
 * full `BackgroundScheduler` class implements it; the test placeholder
 * `StaticScheduler` does too, so the route is indifferent to whether a
 * scheduler is wired.
 */
export interface SchedulerSurface {
  readonly jobIds: () => readonly string[]
  readonly status: (jobId: string) => Promise<BackgroundJobRecord | null>
  readonly listStatus: () => Promise<readonly BackgroundJobRecord[]>
  readonly trigger: (jobId: string) => Promise<BackgroundJobRecord | null>
}

/**
 * A scheduler surface that returns nothing. The app's HTTP layer falls back
 * to this when no real scheduler has been wired, so the management route
 * still answers with an empty list. The runtime scheduler is the only thing
 * that actually runs jobs.
 */
export class StaticScheduler implements SchedulerSurface {
  // The database is captured so the placeholder mirrors the `BackgroundScheduler`
  // constructor signature; tests that want to assert the route's behavior
  // without a real scheduler can pass anything here.
  readonly #database: Database

  constructor(database: Database) {
    this.#database = database
  }

  jobIds(): readonly string[] {
    return []
  }

  async status(_jobId: string): Promise<BackgroundJobRecord | null> {
    return await this.#database.backgroundJobs.get(_jobId)
  }

  async listStatus(): Promise<readonly BackgroundJobRecord[]> {
    return await this.#database.backgroundJobs.list()
  }

  async trigger(): Promise<BackgroundJobRecord | null> {
    // The real scheduler exposes its job list; the static placeholder has
    // none, so a trigger always returns null and the route answers 404.
    return null
  }
}
