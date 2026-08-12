import { installShutdownSignalHandlers } from './runtime/signals.ts'
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

installShutdownSignalHandlers(iroha)
