import { describe, expect, test } from 'bun:test'
import { createSecretCipher, SecretCipherError } from '../../src/crypto/index.ts'

const MASTER_KEY = 'a-master-key-long-enough-for-tests-0123456789'
const PLAINTEXT = 'sk-upstream-secret-value'

describe('the secret cipher', () => {
  test('recovers what it encrypted', async () => {
    const cipher = createSecretCipher(MASTER_KEY)

    expect(await cipher.decrypt(await cipher.encrypt(PLAINTEXT))).toBe(PLAINTEXT)
  })

  test('round-trips unicode and long material', async () => {
    const cipher = createSecretCipher(MASTER_KEY)
    const awkward = `${'ключ-密钥-🔑'.repeat(200)} with spaces and 'quotes'`

    expect(await cipher.decrypt(await cipher.encrypt(awkward))).toBe(awkward)
  })

  test('never lets the plaintext travel inside the stored form', async () => {
    const cipher = createSecretCipher(MASTER_KEY)

    const stored = await cipher.encrypt(PLAINTEXT)

    expect(stored).not.toContain(PLAINTEXT)
    expect(stored).not.toContain(Buffer.from(PLAINTEXT).toString('base64'))
  })

  test('encrypts the same plaintext differently each time', async () => {
    const cipher = createSecretCipher(MASTER_KEY)

    expect(await cipher.encrypt(PLAINTEXT)).not.toBe(await cipher.encrypt(PLAINTEXT))
  })

  test('refuses to decrypt with a different master key', async () => {
    const other = createSecretCipher('another-master-key-entirely-0123456789abcdef')
    const stored = await createSecretCipher(MASTER_KEY).encrypt(PLAINTEXT)

    await expect(other.decrypt(stored)).rejects.toBeInstanceOf(SecretCipherError)
  })

  test('refuses a stored form that was tampered with', async () => {
    const cipher = createSecretCipher(MASTER_KEY)
    const stored = await cipher.encrypt(PLAINTEXT)

    const [version, iv, payload] = stored.split('.')
    if (version === undefined || iv === undefined || payload === undefined) {
      throw new Error('The stored form lost its shape')
    }
    const flipped = payload.slice(0, -2) + (payload.endsWith('AA') ? 'BB' : 'AA')

    await expect(cipher.decrypt(`${version}.${iv}.${flipped}`)).rejects.toBeInstanceOf(
      SecretCipherError,
    )
  })

  test.each([
    ['an empty string', ''],
    ['an unknown version', 'v9.aaaa.bbbb'],
    ['a truncated payload', 'v1.aaaaaaaaaaaaaaaa.aaaa'],
    ['garbage', 'not a stored secret'],
  ])('refuses %s', async (_label, stored) => {
    await expect(createSecretCipher(MASTER_KEY).decrypt(stored)).rejects.toBeInstanceOf(
      SecretCipherError,
    )
  })

  test('explains itself without quoting any secret material', async () => {
    const cipher = createSecretCipher(MASTER_KEY)
    const stored = await cipher.encrypt(PLAINTEXT)

    const message = await createSecretCipher('another-master-key-entirely-0123456789abcdef')
      .decrypt(stored)
      .then(() => '(no error)')
      .catch((error: unknown) => (error as Error).message)

    expect(message).not.toContain(PLAINTEXT)
  })
})
