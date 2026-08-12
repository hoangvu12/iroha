/**
 * Why Iroha is not yet able to accept traffic, or `null` when it is.
 *
 * Readiness is deliberately narrower than liveness: the process can be running
 * and answering `/health/live` before configuration and migrations are ready, and it
 * keeps running while it drains during shutdown.
 */
export type UnreadyReason = 'configuration_invalid' | 'migrations_pending' | 'shutting_down' | 'database_unavailable'

export class ReadinessState {
  #configured = false
  #migrated = false
  #shuttingDown = false

  markConfigured(): void {
    this.#configured = true
  }

  /** Called once startup has applied every pending migration. */
  markMigrated(): void {
    this.#migrated = true
  }

  /** Called when shutdown begins, so load balancers stop sending new work. */
  beginShutdown(): void {
    this.#shuttingDown = true
  }

  /**
   * The reason traffic cannot be served, ignoring database connectivity, which
   * the health route checks separately because it can change between requests.
   */
  staticReason(): Exclude<UnreadyReason, 'database_unavailable'> | null {
    if (this.#shuttingDown) return 'shutting_down'
    if (!this.#configured) return 'configuration_invalid'
    if (!this.#migrated) return 'migrations_pending'
    return null
  }
}
