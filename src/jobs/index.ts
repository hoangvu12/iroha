/**
 * Bounded background operations: the scheduler, the typed jobs it runs, and
 * the Owner's schedule settings.
 */
export {
  BackgroundScheduler,
  BackgroundJobError,
  type BackgroundJob,
  type BackgroundJobCollaborators,
  type BackgroundJobContext,
  type BackgroundJobRunResult,
  type SchedulerOptions,
} from './scheduler.ts'
export {
  BackgroundScheduleSettingsService,
  DEFAULT_BACKGROUND_SCHEDULE,
  SettingsValidationError,
  type BackgroundScheduleSettings,
} from './schedule-settings.ts'
export {
  JOB_IDS,
  buildDefaultJobs,
  connectionIsDue,
  effectiveIntervalFor,
  type ConnectionVisitingJob,
  type JobId,
} from './jobs.ts'
