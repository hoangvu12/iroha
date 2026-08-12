import { describeStartupFailure, startIroha } from './runtime/startup.ts'

/**
 * The `bun start` entry point. Startup failures print an operator-readable
 * explanation and exit non-zero rather than leaving a half-configured process
 * alive for a supervisor to keep restarting.
 */
const iroha = await startIroha().catch((error: unknown) => {
  console.error(describeStartupFailure(error))
  process.exit(1)
})

// Ticket 17 replaces this with a draining shutdown that honours a grace period.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void iroha.stop().then(() => process.exit(0))
  })
}
