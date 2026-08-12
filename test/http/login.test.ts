import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { hashSecret } from '../../src/identity/index.ts'
import { completeSetup, createTestApp, errorCode, signIn, type TestApp } from '../support/app.ts'
import { testPasswordHasher } from '../support/identity.ts'

const splitOnce = (value: string, separator: string): [string, string] => {
  const at = value.indexOf(separator)
  return at < 0 ? [value, ''] : [value.slice(0, at), value.slice(at + 1)]
}

/** Counts verifications, so a test can see work that was skipped. */
function countingHasher() {
  let verifications = 0

  return {
    hasher: {
      hash: (password: string) => testPasswordHasher.hash(password),
      verify: (password: string, hash: string) => {
        verifications += 1
        return testPasswordHasher.verify(password, hash)
      },
    },
    reset: () => {
      verifications = 0
    },
    get verifications() {
      return verifications
    },
  }
}

const PASSWORD = 'correct horse battery staple'

describe('login', () => {
  let iroha: TestApp

  beforeEach(async () => {
    iroha = await createTestApp()
    await completeSetup(iroha)
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  const login = (body: unknown) =>
    iroha.fetch('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  test('accepts the Owner credentials and issues a session', async () => {
    const response = await login({ username: 'owner', password: PASSWORD })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      setupRequired: false,
      authenticated: true,
      recoveryEnabled: false,
      owner: { username: 'owner' },
      session: { id: expect.any(String), csrfToken: expect.any(String) },
    })
    expect(response.headers.getSetCookie()[0]).toStartWith('iroha_session=')
  })

  test('accepts a username with surrounding whitespace', async () => {
    expect((await login({ username: '  owner  ', password: PASSWORD })).status).toBe(200)
  })

  test.each([
    ['the wrong password', { username: 'owner', password: 'not the password at all' }],
    ['an unknown username', { username: 'someone', password: PASSWORD }],
    ['a missing password', { username: 'owner' }],
    ['an empty body', {}],
  ])('reports %s identically', async (_label, body) => {
    const response = await login(body)

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: { code: 'invalid_credentials', message: 'That username and password do not match.' },
    })
    expect(response.headers.getSetCookie()).toEqual([])
  })

  test('never echoes the submitted password', async () => {
    const response = await login({ username: 'owner', password: 'a wrong but memorable password' })

    expect(await response.text()).not.toContain('a wrong but memorable password')
  })

  test('does not reveal whether recovery is possible in a failure', async () => {
    const response = await login({ username: 'owner', password: 'wrong password entirely' })

    expect(await response.text()).not.toContain('recovery')
  })

  test('throttles repeated password guessing and says how long to wait', async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      await login({ username: 'owner', password: `guess number ${attempt}` })
    }

    const response = await login({ username: 'owner', password: PASSWORD })

    expect(response.status).toBe(429)
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  test('forgets failed attempts once the throttle window passes', async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      await login({ username: 'owner', password: `guess number ${attempt}` })
    }
    iroha.clock.advance(15 * 60 + 1)

    expect((await login({ username: 'owner', password: PASSWORD })).status).toBe(200)
  })

  test('a successful login clears the failure count', async () => {
    for (let attempt = 0; attempt < 9; attempt++) {
      await login({ username: 'owner', password: `guess number ${attempt}` })
    }
    await login({ username: 'owner', password: PASSWORD })

    for (let attempt = 0; attempt < 9; attempt++) {
      await login({ username: 'owner', password: `guess again ${attempt}` })
    }

    expect((await login({ username: 'owner', password: PASSWORD })).status).toBe(200)
  })

  test('spends the same verification cost on a username that cannot match', async () => {
    const counting = countingHasher()
    const watched = await createTestApp({ passwordHasher: counting.hasher })

    try {
      await completeSetup(watched)
      counting.reset()

      await watched.fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'not-the-owner', password: PASSWORD }),
      })

      // Skipping the hash for an unknown username would let a caller learn the
      // Owner's username from how quickly the rejection came back.
      expect(counting.verifications).toBe(1)
    } finally {
      await watched.dispose()
    }
  })

  test('refuses a cross-origin login attempt', async () => {
    const response = await iroha.fetch('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://attacker.example' },
      body: JSON.stringify({ username: 'owner', password: PASSWORD }),
    })

    expect(response.status).toBe(403)
  })

  test('audits successes and failures without the attempted values', async () => {
    await login({ username: 'owner', password: 'a wrong but memorable password' })
    await login({ username: 'owner', password: PASSWORD })

    const events = await iroha.database.audit.list()
    expect(events.map((event) => `${event.action}:${event.outcome}`)).toEqual([
      'owner.login:success',
      'owner.login:failure',
      'owner.setup:success',
    ])
    expect(JSON.stringify(events)).not.toContain('a wrong but memorable password')
  })
})

describe('an unclaimed installation', () => {
  let iroha: TestApp

  beforeEach(async () => {
    iroha = await createTestApp()
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  test('rejects login without hinting that no Owner exists', async () => {
    const response = await iroha.fetch('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: PASSWORD }),
    })

    expect(response.status).toBe(401)
    expect(await errorCode(response)).toBe('invalid_credentials')
  })

  test('still spends the verification cost, so an empty installation is not obvious', async () => {
    const counting = countingHasher()
    const watched = await createTestApp({ passwordHasher: counting.hasher })

    try {
      await watched.fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'owner', password: PASSWORD }),
      })

      expect(counting.verifications).toBe(1)
    } finally {
      await watched.dispose()
    }
  })
})

describe('the session cookie', () => {
  let iroha: TestApp

  beforeEach(async () => {
    iroha = await createTestApp()
    await completeSetup(iroha)
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  test('is marked Secure when the browser arrived over TLS', async () => {
    const response = await iroha.app.handle(
      new Request('http://iroha.test/api/v1/auth/login', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://iroha.test',
          'x-forwarded-proto': 'https',
        },
        body: JSON.stringify({ username: 'owner', password: PASSWORD }),
      }),
    )

    expect(response.headers.getSetCookie()[0]?.toLowerCase()).toContain('secure')
  })

  test('is not marked Secure on a plain-HTTP installation, which could not send it back', async () => {
    const response = await iroha.fetch('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: PASSWORD }),
    })

    expect(response.headers.getSetCookie()[0]?.toLowerCase()).not.toContain('secure')
  })

  test('stores the session secret only as a hash', async () => {
    const response = await iroha.fetch('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: PASSWORD }),
    })

    const cookieValue = response.headers.getSetCookie()[0]?.split(';')[0]?.split('=')[1] ?? ''
    const [id = '', secret = ''] = splitOnce(cookieValue, '.')

    const stored = await iroha.database.sessions.get(id)
    expect(secret).not.toBe('')
    expect(stored?.secretHash).not.toBe(secret)
    expect(stored?.secretHash).toBe(hashSecret(secret))
  })

  test('is rejected when its secret is altered', async () => {
    const { sessionId } = await signIn(iroha)

    const response = await iroha.app.handle(
      new Request('http://iroha.test/api/v1/auth/sessions', {
        headers: { origin: 'http://iroha.test', cookie: `iroha_session=${sessionId}.forged` },
      }),
    )

    expect(response.status).toBe(401)
  })

  test('is rejected when its session was revoked elsewhere', async () => {
    const { sessionId } = await signIn(iroha)
    await iroha.database.sessions.remove(sessionId)

    expect((await iroha.fetch('/api/v1/auth/sessions')).status).toBe(401)
  })
})
