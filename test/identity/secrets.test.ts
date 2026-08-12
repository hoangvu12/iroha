import { describe, expect, test } from 'bun:test'
import {
  argon2idPasswordHasher,
  hashSecret,
  randomSecret,
  secretsMatch,
} from '../../src/identity/index.ts'
import { testPasswordHasher } from '../support/identity.ts'

describe('random secrets', () => {
  test('are URL-safe and long enough to resist guessing', () => {
    const secret = randomSecret()

    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/)
    // 32 bytes of entropy, base64url encoded.
    expect(secret.length).toBeGreaterThanOrEqual(43)
  })

  test('do not repeat', () => {
    const secrets = new Set(Array.from({ length: 100 }, () => randomSecret()))

    expect(secrets.size).toBe(100)
  })
})

describe('secret hashing', () => {
  test('is deterministic for the same secret', () => {
    const secret = randomSecret()

    expect(hashSecret(secret)).toBe(hashSecret(secret))
  })

  test('does not contain the secret', () => {
    const secret = randomSecret()

    expect(hashSecret(secret)).not.toContain(secret)
  })

  test('differs between secrets', () => {
    expect(hashSecret('one')).not.toBe(hashSecret('two'))
  })
})

describe('secret comparison', () => {
  test('accepts identical values', () => {
    expect(secretsMatch('abc', 'abc')).toBe(true)
  })

  test.each([
    ['a different value', 'abc', 'abd'],
    ['a different length', 'abc', 'abcd'],
    ['an empty candidate', 'abc', ''],
  ])('rejects %s', (_label, expected, candidate) => {
    expect(secretsMatch(expected, candidate)).toBe(false)
  })
})

describe('password hashing', () => {
  for (const [label, hasher] of [
    ['argon2id', argon2idPasswordHasher],
    ['the test hasher', testPasswordHasher],
  ] as const) {
    describe(label, () => {
      test('verifies the correct password', async () => {
        const hash = await hasher.hash('correct horse battery staple')

        expect(await hasher.verify('correct horse battery staple', hash)).toBe(true)
      })

      test('rejects the wrong password', async () => {
        const hash = await hasher.hash('correct horse battery staple')

        expect(await hasher.verify('Correct horse battery staple', hash)).toBe(false)
      })

      test('never stores the password itself', async () => {
        const hash = await hasher.hash('correct horse battery staple')

        expect(hash).not.toContain('correct horse battery staple')
        expect(hash.startsWith('$argon2id$')).toBe(true)
      })

      test('salts, so the same password hashes differently each time', async () => {
        const first = await hasher.hash('correct horse battery staple')
        const second = await hasher.hash('correct horse battery staple')

        expect(first).not.toBe(second)
      })

      test('rejects a corrupted stored hash rather than throwing', async () => {
        expect(await hasher.verify('correct horse battery staple', 'not-a-hash')).toBe(false)
      })
    })
  }
})
