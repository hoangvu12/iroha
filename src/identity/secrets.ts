import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** 32 bytes of entropy, which is more than a session cookie needs to resist guessing. */
const SECRET_BYTES = 32

/** A URL- and cookie-safe random secret. */
export function randomSecret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url')
}

/**
 * The stored form of a high-entropy secret.
 *
 * SHA-256 is correct here precisely because the input is random: there is
 * nothing to brute-force, so the deliberate slowness of a password hash would
 * only tax every authenticated request. Passwords use {@link PasswordHasher}.
 */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('base64url')
}

/**
 * Compares two secrets in time independent of how far they match, so that a
 * caller cannot discover a secret one character at a time.
 */
export function secretsMatch(expected: string, candidate: string): boolean {
  const expectedBytes = Buffer.from(expected, 'utf8')
  const candidateBytes = Buffer.from(candidate, 'utf8')

  // `timingSafeEqual` requires equal lengths, and length itself is not a
  // meaningful leak for fixed-length generated secrets.
  if (expectedBytes.length !== candidateBytes.length) return false

  return timingSafeEqual(expectedBytes, candidateBytes)
}
