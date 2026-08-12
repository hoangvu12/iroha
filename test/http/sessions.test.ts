import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  authState,
  completeSetup,
  createTestApp,
  errorCode,
  type TestApp,
} from '../support/app.ts'

interface SessionListing {
  readonly sessions: readonly {
    id: string
    current: boolean
    createdAt: string
    lastSeenAt: string
    expiresAt: string
    userAgent: string | null
  }[]
}

describe('owner sessions', () => {
  let iroha: TestApp
  let csrf: string
  let sessionId: string

  beforeEach(async () => {
    iroha = await createTestApp()
    ;({ csrf, sessionId } = await completeSetup(iroha))
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  const list = async (): Promise<SessionListing> => {
    const response = await iroha.fetch('/api/v1/auth/sessions')
    expect(response.status).toBe(200)
    return (await response.json()) as SessionListing
  }

  test('lists the current session with its client description', async () => {
    const { sessions } = await list()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      id: sessionId,
      current: true,
      userAgent: 'Test Browser',
    })
  })

  test('never lists a session secret', async () => {
    const response = await iroha.fetch('/api/v1/auth/sessions')
    const stored = await iroha.database.sessions.get(sessionId)

    const body = await response.text()
    expect(body).not.toContain(stored?.secretHash ?? 'missing')
    expect(body).not.toContain('secretHash')
  })

  test('shows other signed-in browsers alongside the current one', async () => {
    const other = await createOtherBrowser(iroha)

    const { sessions } = await list()
    expect(sessions).toHaveLength(2)
    expect(sessions.find((session) => session.id === other)?.current).toBe(false)
    expect(sessions.find((session) => session.id === sessionId)?.current).toBe(true)
  })

  test('revokes another browser without signing this one out', async () => {
    const other = await createOtherBrowser(iroha)

    const response = await iroha.fetch(`/api/v1/auth/sessions/${other}`, { method: 'DELETE', csrf })

    expect(response.status).toBe(204)
    expect((await list()).sessions.map((session) => session.id)).toEqual([sessionId])
  })

  test('reports revoking a session that is already gone', async () => {
    const response = await iroha.fetch('/api/v1/auth/sessions/absent', { method: 'DELETE', csrf })

    expect(response.status).toBe(404)
    expect(await errorCode(response)).toBe('session_not_found')
  })

  test('signs out, clearing the cookie and the stored session', async () => {
    const response = await iroha.fetch('/api/v1/auth/logout', { method: 'POST', csrf })

    expect(response.status).toBe(204)
    expect(await iroha.database.sessions.get(sessionId)).toBeNull()
    expect(await authState(iroha)).toMatchObject({ authenticated: false, setupRequired: false })
  })

  test('signs out everywhere, including this browser', async () => {
    await createOtherBrowser(iroha)

    const response = await iroha.fetch('/api/v1/auth/sessions', { method: 'DELETE', csrf })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ revoked: 2 })
    expect(await iroha.database.sessions.list()).toEqual([])
    expect(await authState(iroha)).toMatchObject({ authenticated: false })
  })

  test('audits revocations without any secret', async () => {
    const other = await createOtherBrowser(iroha)
    await iroha.fetch(`/api/v1/auth/sessions/${other}`, { method: 'DELETE', csrf })
    await iroha.fetch('/api/v1/auth/logout', { method: 'POST', csrf })

    const actions = (await iroha.database.audit.list()).map((event) => event.action)
    expect(actions).toContain('owner.session_revoked')
    expect(actions).toContain('owner.logout')
  })

  describe('CSRF protection', () => {
    test.each([
      ['logout', '/api/v1/auth/logout', 'POST'],
      ['revoking every session', '/api/v1/auth/sessions', 'DELETE'],
    ])('refuses %s without the session token', async (_label, path, method) => {
      const response = await iroha.fetch(path, { method })

      expect(response.status).toBe(403)
      expect(await errorCode(response)).toBe('csrf_token_invalid')
      expect(await iroha.database.sessions.get(sessionId)).not.toBeNull()
    })

    test('refuses a token belonging to a different session', async () => {
      const other = await createOtherBrowser(iroha)
      const otherToken = (await iroha.database.sessions.get(other))?.csrfToken ?? ''

      const response = await iroha.fetch('/api/v1/auth/logout', {
        method: 'POST',
        csrf: otherToken,
      })

      expect(response.status).toBe(403)
    })

    test('does not require a token to read state or list sessions', async () => {
      expect((await iroha.fetch('/api/v1/auth/state')).status).toBe(200)
      expect((await iroha.fetch('/api/v1/auth/sessions')).status).toBe(200)
    })
  })

  describe('without a session', () => {
    test.each([
      ['listing sessions', '/api/v1/auth/sessions', 'GET'],
      ['logging out', '/api/v1/auth/logout', 'POST'],
      ['revoking every session', '/api/v1/auth/sessions', 'DELETE'],
    ])('refuses %s', async (_label, path, method) => {
      const anonymous = await createTestApp()
      await completeSetup(anonymous)

      try {
        const response = await anonymous.app.handle(
          new Request(`http://iroha.test${path}`, { method, headers: { origin: 'http://iroha.test' } }),
        )

        expect(response.status).toBe(401)
        expect(await errorCode(response)).toBe('authentication_required')
      } finally {
        await anonymous.dispose()
      }
    })
  })
})

describe('sliding session renewal', () => {
  let iroha: TestApp

  beforeEach(async () => {
    iroha = await createTestApp({ sessionIdleSeconds: 3600 })
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  test('extends the expiry when the session is used again', async () => {
    const { sessionId } = await completeSetup(iroha)
    const original = (await iroha.database.sessions.get(sessionId))?.expiresAt

    iroha.clock.advance(1800)
    expect((await iroha.fetch('/api/v1/auth/state')).status).toBe(200)

    const extended = (await iroha.database.sessions.get(sessionId))?.expiresAt
    expect(extended?.getTime()).toBeGreaterThan(original?.getTime() ?? 0)
  })

  test('reissues the cookie so the browser expires no sooner than the session', async () => {
    await completeSetup(iroha)

    iroha.clock.advance(1800)
    const response = await iroha.fetch('/api/v1/auth/state')

    const [cookie = ''] = response.headers.getSetCookie()
    expect(cookie).toStartWith('iroha_session=')
    expect(cookie).toContain('Max-Age=3600')
  })

  test('does not reissue the cookie on every request', async () => {
    await completeSetup(iroha)

    iroha.clock.advance(5)
    const response = await iroha.fetch('/api/v1/auth/state')

    expect(response.headers.getSetCookie()).toEqual([])
  })

  test('a browser in continuous use is never signed out by the original expiry', async () => {
    await completeSetup(iroha)

    // Well past the original hour, having used Iroha every half hour.
    for (let visit = 0; visit < 6; visit++) {
      iroha.clock.advance(1800)
      expect(await authState(iroha)).toMatchObject({ authenticated: true })
    }
  })

  test('does not write to the session on every request', async () => {
    const { sessionId } = await completeSetup(iroha)
    const original = await iroha.database.sessions.get(sessionId)

    iroha.clock.advance(5)
    await iroha.fetch('/api/v1/auth/state')

    expect((await iroha.database.sessions.get(sessionId))?.lastSeenAt).toEqual(
      original?.lastSeenAt ?? new Date(0),
    )
  })

  test('refuses a session left idle past its expiry and forgets it', async () => {
    const { sessionId } = await completeSetup(iroha)

    iroha.clock.advance(3601)

    expect(await authState(iroha)).toMatchObject({ authenticated: false })
    expect(await iroha.database.sessions.get(sessionId)).toBeNull()
  })

  test('keeps a session alive across a gap shorter than the idle limit', async () => {
    await completeSetup(iroha)

    for (let hour = 0; hour < 5; hour++) {
      iroha.clock.advance(1800)
      expect(await authState(iroha)).toMatchObject({ authenticated: true })
    }
  })
})

/** Signs in from a second browser, returning its session ID. */
async function createOtherBrowser(iroha: TestApp): Promise<string> {
  const response = await iroha.app.handle(
    new Request('http://iroha.test/api/v1/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://iroha.test',
        'user-agent': 'Other Browser',
      },
      body: JSON.stringify({ username: 'owner', password: 'correct horse battery staple' }),
    }),
  )

  expect(response.status).toBe(200)
  const body = (await response.json()) as { session: { id: string } }
  return body.session.id
}
