/**
 * One-shot diagnostic for the Usage column on the Provider detail page.
 *
 * Reads the configured Iroha database and reports:
 *   - the Provider's `templateId` (the cause of most "Usage stays at —" cases)
 *   - the Usage Adapter that `UsageService` would resolve for it
 *   - the latest Usage Snapshot (visibility, last reading, last failure)
 *   - the most recent `usage.refreshed` audit events
 *   - the Upstream Keys attached
 *
 * Use:
 *   bun run scripts/diagnose-usage.ts <provider-id>
 *
 * Pass `--audit-all` to dump every recent `usage.refreshed` event in the audit
 * log instead of filtering by provider id.
 */
import { loadConfiguration } from '../src/config/environment.ts'
import { openDatabase } from '../src/persistence/index.ts'
import { createBuiltInAdapterRegistry } from '../src/providers/adapter-registry.ts'

const providerId = process.argv[2]
const auditAll = process.argv.includes('--audit-all')

if (!providerId) {
  console.error('Usage: bun run scripts/diagnose-usage.ts <provider-id> [--audit-all]')
  process.exit(1)
}

const config = loadConfiguration()
const db = openDatabase(config.database)
const registry = createBuiltInAdapterRegistry()

try {
  const provider = await db.providers.getProvider(providerId)
  if (provider === null) {
    console.log(`Provider ${providerId}: NOT FOUND`)
    process.exit(0)
  }

  console.log(`=== Provider ${provider.id} ===`)
  console.log(JSON.stringify(
    {
      id: provider.id,
      displayName: provider.displayName,
      baseUrl: provider.baseUrl,
      templateId: provider.templateId,
      enabled: provider.enabled,
      archivedAt: provider.archivedAt?.toISOString() ?? null,
    },
    null,
    2,
  ))

  let resolved = 'reactive-only-usage-adapter (default fallback — typed adapter not selected)'
  if (provider.templateId !== null) {
    const template = registry.providerTemplate(provider.templateId)
    if (template === null) {
      resolved = `template id "${provider.templateId}" is not in the registry`
    } else if (template.usageAdapterId === null) {
      resolved = `template "${template.id}" declares no usageAdapterId`
    } else {
      const adapter = registry.usageAdapter(template.usageAdapterId)
      if (adapter === null) {
        resolved = `template names "${template.usageAdapterId}" but the registry does not have it`
      } else {
        resolved = `${template.usageAdapterId} (visibility: ${adapter.visibility})`
      }
    }
  } else {
    resolved += '  ←  templateId is null: the typed MiniMax adapter will never run for this Provider'
  }
  console.log(`\n=== Resolved Usage Adapter ===\n${resolved}`)

  const snapshot = await db.usage.get(providerId)
  console.log(`\n=== Usage Snapshot ===`)
  if (snapshot === null) {
    console.log('No snapshot yet (no poll has ever succeeded).')
  } else {
    console.log(JSON.stringify(
      {
        visibility: snapshot.visibility,
        syncedAt: snapshot.syncedAt?.toISOString() ?? null,
        lastSuccessAt: snapshot.lastSuccessAt?.toISOString() ?? null,
        lastFailureAt: snapshot.lastFailureAt?.toISOString() ?? null,
        lastFailureCode: snapshot.lastFailureCode,
        lastFailureMessage: snapshot.lastFailureMessage,
        result: snapshot.result,
      },
      null,
      2,
    ))
  }

  const audits = await db.audit.list({ limit: 500 })
  const relevant = auditAll
    ? audits.filter((a) => a.action === 'usage.refreshed')
    : audits.filter((a) => {
        if (a.action !== 'usage.refreshed') return false
        if (typeof a.detail !== 'object' || a.detail === null) return false
        const detail = a.detail as { providerId?: unknown }
        return detail.providerId === providerId
      })
  console.log(`\n=== usage.refreshed audit events (${relevant.length}) ===`)
  for (const audit of relevant.slice(0, 20)) {
    console.log(JSON.stringify(
      {
        occurredAt: audit.occurredAt.toISOString(),
        outcome: audit.outcome,
        detail: audit.detail,
      },
      null,
      2,
    ))
  }

  const keys = await db.providers.listKeys(providerId)
  console.log(`\n=== Upstream Keys (${keys.length}) ===`)
  for (const key of keys) {
    console.log(
      `  ${key.id}: health=${key.health}, scope=${key.healthScope}, encryptedKeyLen=${key.encryptedKey.length}`,
    )
  }

  const jobs = await db.backgroundJobs.list()
  console.log(`\n=== Background Jobs ===`)
  for (const job of jobs) {
    console.log(JSON.stringify({
      jobId: job.jobId,
      status: job.status,
      lastOutcome: job.lastOutcome,
      lastStartedAt: job.lastStartedAt?.toISOString() ?? null,
      lastCompletedAt: job.lastCompletedAt?.toISOString() ?? null,
      lastErrorCode: job.lastErrorCode,
      lastErrorMessage: job.lastErrorMessage,
    }, null, 2))
  }
} finally {
  await db.close()
}