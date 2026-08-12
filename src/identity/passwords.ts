/**
 * How the Owner's password is stored and checked.
 *
 * Injected at the composition boundary so that tests can lower the work factor
 * without replacing the real algorithm, and so that a future change of cost
 * parameters has one home.
 */
export interface PasswordHasher {
  /** Returns a self-describing hash. The password itself is never recoverable from it. */
  hash(password: string): Promise<string>
  /** Never throws: an unreadable stored hash is a failed verification, not a crash. */
  verify(password: string, hash: string): Promise<boolean>
}

export interface Argon2idOptions {
  /** Kibibytes of memory per hash. */
  readonly memoryCost?: number
  /** Iterations over that memory. */
  readonly timeCost?: number
}

/**
 * Argon2id, the memory-hard default recommended for password storage.
 *
 * The defaults follow Bun's own, which meet the OWASP minimum for argon2id.
 */
export function createArgon2idPasswordHasher(options: Argon2idOptions = {}): PasswordHasher {
  return {
    async hash(password) {
      return await Bun.password.hash(password, { algorithm: 'argon2id', ...options })
    },

    async verify(password, hash) {
      try {
        return await Bun.password.verify(password, hash, 'argon2id')
      } catch {
        // A hash Bun cannot parse means the stored value is not a usable
        // credential, which is a verification failure like any other.
        return false
      }
    },
  }
}

export const argon2idPasswordHasher: PasswordHasher = createArgon2idPasswordHasher()
