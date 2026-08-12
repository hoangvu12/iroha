import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/**
 * Recoverable secret material, encrypted with the installation master key.
 *
 * Upstream Keys must survive a database copy being stolen but stay usable
 * across restarts, so they are encrypted rather than hashed. Version one has
 * no master-key rotation or sentinel check; a stored secret that cannot be
 * decrypted means the master key changed, and says so.
 */
export interface SecretCipher {
  /** Encrypts a secret into a self-describing stored form. Always fresh output. */
  encrypt(plaintext: string): Promise<string>
  /** Recovers the secret. Raises {@link SecretCipherError} if the stored form cannot be trusted. */
  decrypt(stored: string): Promise<string>
}

/**
 * The stored secret cannot be read. The message never quotes the material,
 * which is precisely why it cannot be shown.
 */
export class SecretCipherError extends Error {
  constructor() {
    super('The stored secret cannot be read with this installation\u2019s master key.')
    this.name = 'SecretCipherError'
  }
}

const VERSION = 'v1'
const IV_BYTES = 12
const TAG_BYTES = 16

/**
 * AES-256-GCM keyed from the master key.
 *
 * The master key is an Owner-supplied string of at least 32 characters, so its
 * bytes are normalised to a 256-bit key with SHA-256 rather than stretched:
 * there is no low-entropy guess to slow down, and every decryption would pay
 * for key derivation otherwise. Each encryption uses a fresh random IV, and
 * the authentication tag makes tampering and wrong keys indistinguishable
 * failures.
 */
export function createSecretCipher(masterKey: string): SecretCipher {
  const key = createHash('sha256').update(masterKey, 'utf8').digest()

  return {
    async encrypt(plaintext: string): Promise<string> {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])

      // The tag travels with the ciphertext so one string is the whole stored form.
      const payload = Buffer.concat([cipher.getAuthTag(), encrypted])
      return `${VERSION}.${iv.toString('base64url')}.${payload.toString('base64url')}`
    },

    async decrypt(stored: string): Promise<string> {
      try {
        const [version, ivPart, payloadPart] = stored.split('.')
        if (version !== VERSION || ivPart === undefined || payloadPart === undefined) {
          throw new Error('unrecognised stored form')
        }

        const iv = Buffer.from(ivPart, 'base64url')
        const payload = Buffer.from(payloadPart, 'base64url')
        if (iv.length !== IV_BYTES || payload.length <= TAG_BYTES) {
          throw new Error('truncated stored form')
        }

        const decipher = createDecipheriv('aes-256-gcm', key, iv)
        decipher.setAuthTag(payload.subarray(0, TAG_BYTES))

        const decrypted = Buffer.concat([
          decipher.update(payload.subarray(TAG_BYTES)),
          decipher.final(),
        ])
        return decrypted.toString('utf8')
      } catch {
        throw new SecretCipherError()
      }
    },
  }
}
