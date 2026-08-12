import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  authState,
  completeSetup,
  createTestApp,
  errorCode,
  RECOVERY_TOKEN,
  signIn,
  type TestApp,
} from '../support/app.ts'

const PASSWORD = 'correct horse battery staple'
const NEW_PASSWORD = 'a replacement password entirely'

describe('recovery when a recovery token is configured', () => {
  let iroha: TestApp

  beforeEach(async () => {
    iroha = await createTestApp({ recoveryToken: RECOVERY_TOKEN })
    await completeSetup(iroha)
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  const recover = (body: unknown) =>
    iroha.fetch('/api/v1/auth/recover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  test('advertises that recovery exists without naming the token', async () => {
    const response = await iroha.fetch('/api/v1/auth/state')

    expect((await response.clone().json()) as unknown).toMatchObject({ recoveryEnabled: true })
    expect(await response.text()).not.toContain(RECOVERY_TOKEN)
  })

  test('changes the password and revokes every existing session', async () => {
    const { sessionId } = await signIn(iroha)

    const response = await recover({ recoveryToken: RECOVERY_TOKEN, password: NEW_PASSWORD })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ sessionsRevoked: expect.any(Number) })
    expect(await iroha.database.sessions.get(sessionId)).toBeNull()
    expect(await iroha.database.sessions.list()).toEqual([])
  })

  test('leaves the browser signed out rather than trusting the reset', async () => {
    await recover({ recoveryToken: RECOVERY_TOKEN, password: NEW_PASSWORD })

    expect(await authState(iroha)).toMatchObject({ authenticated: false, setupRequired: false })
  })

  test('accepts the new password and refuses the old one afterwards', async () => {
    await recover({ recoveryToken: RECOVERY_TOKEN, password: NEW_PASSWORD })

    const withOld = await iroha.fetch('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'owner', password: PASSWORD }),
    })
    expect(withOld.status).toBe(401)

    await signIn(iroha, { password: NEW_PASSWORD })
  })

  test('records when the password changed', async () => {
    const before = await iroha.database.owner.get()
    iroha.clock.advance(3600)
    await recover({ recoveryToken: RECOVERY_TOKEN, password: NEW_PASSWORD })

    const after = await iroha.database.owner.get()
    expect(after?.passwordChangedAt.getTime()).toBeGreaterThan(
      before?.passwordChangedAt.getTime() ?? 0,
    )
    expect(after?.createdAt).toEqual(before?.createdAt ?? new Date(0))
  })

  test('rejects the wrong recovery token and keeps the password', async () => {
    const response = await recover({ recoveryToken: 'guess', password: NEW_PASSWORD })

    expect(response.status).toBe(403)
    expect(await errorCode(response)).toBe('recovery_unavailable')
    await signIn(iroha)
  })

  test('rejects a weak new password before it examines the token', async () => {
    const response = await recover({ recoveryToken: 'guess', password: 'short' })

    expect(response.status).toBe(400)
    expect(await errorCode(response)).toBe('validation_failed')
  })

  test('never echoes the recovery token or the new password', async () => {
    const response = await recover({ recoveryToken: RECOVERY_TOKEN, password: NEW_PASSWORD })
    const body = await response.text()

    expect(body).not.toContain(RECOVERY_TOKEN)
    expect(body).not.toContain(NEW_PASSWORD)
  })

  test('audits the reset and its failures without any secret', async () => {
    await recover({ recoveryToken: 'guess', password: NEW_PASSWORD })
    await recover({ recoveryToken: RECOVERY_TOKEN, password: NEW_PASSWORD })

    const events = await iroha.database.audit.list()
    expect(events.map((event) => `${event.action}:${event.outcome}`)).toEqual(
      expect.arrayContaining(['owner.recovery:success', 'owner.recovery:failure']),
    )
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain(RECOVERY_TOKEN)
    expect(serialized).not.toContain(NEW_PASSWORD)
  })

  test('throttles repeated recovery attempts more tightly than login', async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await recover({ recoveryToken: `guess-${attempt}`, password: NEW_PASSWORD })
    }

    const response = await recover({ recoveryToken: RECOVERY_TOKEN, password: NEW_PASSWORD })

    expect(response.status).toBe(429)
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0)
    await signIn(iroha)
  })

  test('refuses a cross-origin recovery attempt', async () => {
    const response = await iroha.fetch('/api/v1/auth/recover', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://attacker.example' },
      body: JSON.stringify({ recoveryToken: RECOVERY_TOKEN, password: NEW_PASSWORD }),
    })

    expect(response.status).toBe(403)
    await signIn(iroha)
  })
})

describe('recovery when no recovery token is configured', () => {
  let iroha: TestApp

  beforeEach(async () => {
    iroha = await createTestApp()
    await completeSetup(iroha)
  })

  afterEach(async () => {
    await iroha.dispose()
  })

  test('reports that recovery is unavailable', async () => {
    expect(await authState(iroha)).toMatchObject({ recoveryEnabled: false })
  })

  test('answers an attempt exactly as it answers a wrong token', async () => {
    const response = await iroha.fetch('/api/v1/auth/recover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recoveryToken: RECOVERY_TOKEN, password: NEW_PASSWORD }),
    })

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: {
        code: 'recovery_unavailable',
        message: 'Recovery is unavailable or the token is not correct.',
      },
    })
    await signIn(iroha)
  })
})

describe('recovery before an Owner exists', () => {
  test('is refused without revealing that the installation is unclaimed', async () => {
    const iroha = await createTestApp({ recoveryToken: RECOVERY_TOKEN })

    try {
      const response = await iroha.fetch('/api/v1/auth/recover', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recoveryToken: RECOVERY_TOKEN, password: NEW_PASSWORD }),
      })

      expect(response.status).toBe(403)
      expect(await errorCode(response)).toBe('recovery_unavailable')
      expect(await iroha.database.owner.get()).toBeNull()
    } finally {
      await iroha.dispose()
    }
  })
})
