/** Print recent failed inference requests and their attempts without secrets. */
import { loadConfiguration } from '../src/config/environment.ts'
import { openDatabase } from '../src/persistence/index.ts'

const providerId = process.argv[2]
if (!providerId) throw new Error('Usage: bun run scripts/diagnose-provider-errors.ts <provider-id>')
const db = openDatabase(loadConfiguration().database)
try {
  const result = await db.requestHistory.listEvents({
    filter: { providerId, outcome: 'failure' },
    limit: process.argv.includes('--all') ? 500 : 25,
  })
  if (process.argv.includes('--summary')) {
    const counts = new Map<string, number>()
    for (const event of result.events) {
      for (const attempt of await db.requestHistory.getAttempts(event.id)) {
        if (attempt.status !== 400) continue
        const key = attempt.keyId ?? 'none'
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
    console.log(JSON.stringify(Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]))))
    process.exit(0)
  }
  for (const event of result.events) {
    const attempts = await db.requestHistory.getAttempts(event.id)
    console.log(JSON.stringify({
      id: event.id,
      at: event.occurredAt.toISOString(),
      model: event.model,
      status: event.status,
      errorCode: event.errorCode,
      attempts: attempts.map((attempt) => ({
        number: attempt.attemptNumber,
        keyId: attempt.keyId,
        status: attempt.status,
        errorCode: attempt.errorCode,
      })),
    }))
  }
} finally {
  await db.close()
}
