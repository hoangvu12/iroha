/**
 * Fair round-robin selection over a volatile, in-memory cursor.
 *
 * The cursor is deliberately not persisted: its only job is to spread
 * consecutive selections evenly across the eligible keys of a pool, and a
 * restart that resets it changes nothing durable. Durable Key Health lives in
 * the database and is what survives restarts.
 *
 * ## Concurrency
 *
 * This component never writes to a database and never awaits: `select` runs
 * from its first line to its return in one synchronous slice of the event
 * loop. Iroha is a single process on a single-threaded JS runtime, so
 * concurrent requests interleave only at `await` boundaries. Because `select`
 * has none, no two callers can observe a half-advanced cursor: each selection
 * reads the cursor, computes its index, and stores the next value atomically
 * with respect to every other caller. That is the whole fairness guarantee,
 * and it needs no lock and no database write.
 */
export class RoundRobinSelector {
  readonly #next = new Map<string, number>()

  /**
   * Returns the next candidate of `pool` in strict rotation, or `null` when
   * there is nothing eligible to choose from. Candidates must already be
   * ordered and eligibility-filtered; this component does not judge them.
   */
  select<T>(pool: string, candidates: readonly T[]): T | null {
    if (candidates.length === 0) return null

    const next = this.#next.get(pool) ?? 0
    const chosen = candidates[next % candidates.length]
    // Atomic within the single-threaded event loop: no `await` separates the
    // read above from this store, so concurrent callers cannot interleave here.
    this.#next.set(pool, next + 1)
    return chosen ?? null
  }

  /** Drops every stored position. Called on restart; never by an inference path. */
  reset(): void {
    this.#next.clear()
  }
}
