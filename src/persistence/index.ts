import type { DatabaseConfiguration } from '../config/environment.ts'
import { openPostgresDatabase } from './postgres/database.ts'
import type { Database } from './repository.ts'
import { openSqliteDatabase } from './sqlite/database.ts'

export type {
  AttemptOutcome,
  AuditEventRecord,
  AuditFilter,
  AuditListOptions,
  AuditListResult,
  AuditOutcome,
  AuditRepository,
  BackgroundJobCompletion,
  BackgroundJobRecord,
  BackgroundJobRepository,
  BackgroundJobStatus,
  ConnectionCapabilities,
  Database,
  GatewayKeyRecord,
  GatewayKeyRepository,
  GatewayKeyScopeEntry,
  KeyProbeVerdict,
  ModelCatalogEntryRecord,
  ModelCatalogRepository,
  ModelCatalogSource,
  ModelCatalogSyncRecord,
  OwnerRecord,
  OwnerRepository,
  ProviderConnectionPatch,
  ProviderConnectionRecord,
  ProviderRepository,
  ProviderStaticHeader,
  Repositories,
  RequestAttemptRecord,
  RequestEventRecord,
  RequestHistoryFilter,
  RequestHistoryListOptions,
  RequestHistoryListResult,
  RequestHistoryRepository,
  RequestOutcome,
  SessionRecord,
  SessionRepository,
  SettingRecord,
  SettingsRepository,
  UpstreamAccountPatch,
  UpstreamAccountRecord,
  UpstreamKeyPatch,
  UpstreamKeyRecord,
  UpstreamKeyHealth,
  UsageRepository,
  UsageSnapshotRecord,
} from './repository.ts'
export { DatabaseUnavailableError } from './repository.ts'

/**
 * Opens the configured database. The dialect is a deployment-time choice: the
 * returned {@link Database} behaves identically either way, and no caller
 * outside `src/persistence/` learns which engine answered.
 *
 * Opening does not migrate. {@link Database.migrate} runs separately so that
 * startup can complete migrations before the server listens.
 */
export function openDatabase(config: DatabaseConfiguration): Database {
  switch (config.dialect) {
    case 'sqlite':
      return openSqliteDatabase(config)
    case 'postgres':
      return openPostgresDatabase(config)
  }
}
