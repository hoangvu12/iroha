import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  authState,
  completeSetup,
  createTestApp,
  errorCode,
  SETUP_TOKEN,
  type TestApp,
} from '../support/app.ts'

const PASSWORD = 'correct horse battery staple'

describe('first-run setup', () => {
  let iroha: TestApp

  beforeEach(async () => {
    iroha = await createTestApp()
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  const setup = (body: unknown) =>
    iroha.fetch('/api/v1/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  test('reports that an unclaimed installation needs setup', async () => {
    const response = await iroha.fetch('/api/v1/auth/state')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      setupRequired: true,
      authenticated: false,
      recoveryEnabled: false,
      owner: null,
      session: null,
    })
  })

  test('creates the sole Owner and signs the browser in', async () => {
    const response = await setup({ username: 'owner', password: PASSWORD, setupToken: SETUP_TOKEN })

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({
      setupRequired: false,
      authenticated: true,
      recoveryEnabled: false,
      owner: { username: 'owner' },
      session: { id: expect.any(String), csrfToken: expect.any(String) },
    })

    expect(await authState(iroha)).toMatchObject({
      setupRequired: false,
      authenticated: true,
      owner: { username: 'owner' },
    })
  })

  test('issues a session cookie the browser cannot read or send cross-site', async () => {
    const response = await setup({ username: 'owner', password: PASSWORD, setupToken: SETUP_TOKEN })
    const [cookie = ''] = response.headers.getSetCookie()

    expect(cookie).toStartWith('iroha_session=')
    expect(cookie.toLowerCase()).toContain('httponly')
    expect(cookie.toLowerCase()).toContain('samesite=strict')
    expect(cookie.toLowerCase()).toContain('path=/')
  })

  test('rejects the wrong setup token without saying what is configured', async () => {
    const response = await setup({ username: 'owner', password: PASSWORD, setupToken: 'guess' })

    expect(response.status).toBe(403)
    const body = await response.text()
    expect(JSON.parse(body)).toEqual({
      error: { code: 'setup_token_invalid', message: expect.any(String) },
    })
    expect(body).not.toContain(SETUP_TOKEN)
    expect(await authState(iroha)).toMatchObject({ setupRequired: true })
  })

  test('rejects setup when no setup token is configured at all', async () => {
    const unconfigured = await createTestApp({ setupToken: undefined })

    try {
      const response = await unconfigured.fetch('/api/v1/auth/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'owner', password: PASSWORD, setupToken: 'anything' }),
      })

      expect(response.status).toBe(403)
      expect(await errorCode(response)).toBe('setup_token_invalid')
    } finally {
      await unconfigured.dispose()
    }
  })

  test('closes permanently once an Owner exists', async () => {
    await completeSetup(iroha)

    const response = await setup({
      username: 'usurper',
      password: 'another sufficiently long password',
      setupToken: SETUP_TOKEN,
    })

    expect(response.status).toBe(409)
    expect(await errorCode(response)).toBe('setup_closed')

    const owner = await iroha.database.owner.get()
    expect(owner?.username).toBe('owner')
  })

  test('reports a repeat attempt as closed even with the wrong setup token', async () => {
    await completeSetup(iroha)

    const response = await setup({ username: 'usurper', password: PASSWORD, setupToken: 'guess' })

    expect(response.status).toBe(409)
  })

  test.each([
    ['a short password', { username: 'owner', password: 'short', setupToken: SETUP_TOKEN }],
    ['a short username', { username: 'ow', password: PASSWORD, setupToken: SETUP_TOKEN }],
    [
      'a username with spaces',
      { username: 'the owner', password: PASSWORD, setupToken: SETUP_TOKEN },
    ],
    ['a missing password', { username: 'owner', setupToken: SETUP_TOKEN }],
  ])('rejects %s', async (_label, body) => {
    const response = await setup(body)

    expect(response.status).toBe(400)
    expect((await response.json()) as unknown).toMatchObject({
      error: { code: 'validation_failed', problems: expect.any(Array) },
    })
    expect(await iroha.database.owner.get()).toBeNull()
  })

  test('never echoes the submitted password', async () => {
    const response = await setup({ username: 'ow', password: PASSWORD, setupToken: SETUP_TOKEN })

    expect(await response.text()).not.toContain(PASSWORD)
  })

  test('stores the password as a salted hash, not as text', async () => {
    await completeSetup(iroha)

    const owner = await iroha.database.owner.get()
    expect(owner?.passwordHash).toStartWith('$argon2id$')
    expect(owner?.passwordHash).not.toContain(PASSWORD)
  })

  test('refuses a cross-origin setup attempt', async () => {
    const response = await iroha.fetch('/api/v1/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://attacker.example' },
      body: JSON.stringify({ username: 'owner', password: PASSWORD, setupToken: SETUP_TOKEN }),
    })

    expect(response.status).toBe(403)
    expect(await errorCode(response)).toBe('cross_origin_denied')
    expect(await iroha.database.owner.get()).toBeNull()
  })

  test('records the claim in audit history without the setup token', async () => {
    await completeSetup(iroha)

    const events = await iroha.database.audit.list()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ action: 'owner.setup', outcome: 'success' })
    expect(JSON.stringify(events)).not.toContain(SETUP_TOKEN)
  })

  test('throttles repeated setup-token guessing', async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      await setup({ username: 'owner', password: PASSWORD, setupToken: `guess-${attempt}` })
    }

    const response = await setup({ username: 'owner', password: PASSWORD, setupToken: SETUP_TOKEN })

    expect(response.status).toBe(429)
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(await iroha.database.owner.get()).toBeNull()
  })
})
