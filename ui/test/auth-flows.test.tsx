import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  completeSetup,
  createTestApp,
  RECOVERY_TOKEN,
  SETUP_TOKEN,
  type TestApp,
} from '../../test/support/app.ts'
import { registerDom, unregisterDom, useGatewayAsFetch } from './browser.ts'

registerDom()

const { cleanup, render, screen, waitFor, within } = await import('@testing-library/react')
const { default: userEvent } = await import('@testing-library/user-event')
const { default: App } = await import('../src/App')

const PASSWORD = 'correct horse battery staple'

describe('the management application in a browser', () => {
  let iroha: TestApp
  let restoreFetch: () => void
  const user = userEvent.setup({ delay: null })

  const start = async (options: Parameters<typeof createTestApp>[0] = {}) => {
    iroha = await createTestApp(options)
    restoreFetch = useGatewayAsFetch(iroha)
  }

  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(async () => {
    cleanup()
    restoreFetch?.()
    await iroha?.dispose()
  })

  afterAll(async () => {
    await unregisterDom()
  })

  describe('first-run setup', () => {
    beforeEach(async () => {
      await start()
    })

    test('asks an unclaimed installation to be claimed, then signs the Owner in', async () => {
      render(<App />)

      await screen.findByRole('heading', { name: 'Claim this installation' })

      await user.type(screen.getByLabelText('Setup token'), SETUP_TOKEN)
      await user.type(screen.getByLabelText('Username'), 'owner')
      await user.type(screen.getByLabelText('Password'), PASSWORD)
      await user.click(screen.getByRole('button', { name: 'Create Owner account' }))

      await screen.findByRole('heading', { name: 'Runtime' })
      expect(await iroha.database.owner.get()).toMatchObject({ username: 'owner' })
    })

    test('keeps the Owner on the setup form when the token is wrong', async () => {
      render(<App />)
      await screen.findByRole('heading', { name: 'Claim this installation' })

      await user.type(screen.getByLabelText('Setup token'), 'a wrong token')
      await user.type(screen.getByLabelText('Username'), 'owner')
      await user.type(screen.getByLabelText('Password'), PASSWORD)
      await user.click(screen.getByRole('button', { name: 'Create Owner account' }))

      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toContain('Setup token rejected')
      expect(screen.getByRole('heading', { name: 'Claim this installation' })).toBeDefined()
      expect(await iroha.database.owner.get()).toBeNull()
    })

    test('reports a password that is too short without discarding the form', async () => {
      render(<App />)
      await screen.findByRole('heading', { name: 'Claim this installation' })

      await user.type(screen.getByLabelText('Setup token'), SETUP_TOKEN)
      await user.type(screen.getByLabelText('Username'), 'owner')
      await user.type(screen.getByLabelText('Password'), 'short')
      await user.click(screen.getByRole('button', { name: 'Create Owner account' }))

      await screen.findByText('must be at least 12 characters')
      expect((screen.getByLabelText('Username') as HTMLInputElement).value).toBe('owner')
    })
  })

  describe('once an Owner exists', () => {
    beforeEach(async () => {
      await start()
      await completeSetup(iroha)
      await iroha.fetch('/api/v1/auth/sessions', { method: 'DELETE', csrf: await currentCsrf(iroha) })
    })

    test('offers sign-in rather than setup', async () => {
      render(<App />)

      await screen.findByRole('heading', { name: 'Sign in' })
      expect(screen.queryByRole('heading', { name: 'Claim this installation' })).toBeNull()
    })

    test('reports a wrong password without saying which value was wrong', async () => {
      render(<App />)
      await screen.findByRole('heading', { name: 'Sign in' })

      await user.type(screen.getByLabelText('Username'), 'owner')
      await user.type(screen.getByLabelText('Password'), 'not the right password')
      await user.click(screen.getByRole('button', { name: 'Sign in' }))

      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toContain('That username and password do not match.')
    })

    test('signs in, shows the Owner, and signs out again', async () => {
      render(<App />)
      await screen.findByRole('heading', { name: 'Sign in' })

      await user.type(screen.getByLabelText('Username'), 'owner')
      await user.type(screen.getByLabelText('Password'), PASSWORD)
      await user.click(screen.getByRole('button', { name: 'Sign in' }))

      await screen.findByRole('heading', { name: 'Runtime' })
      expect(screen.getByText('owner')).toBeDefined()

      await user.click(screen.getByRole('button', { name: 'Sign out' }))

      await screen.findByRole('heading', { name: 'Sign in' })
      expect(await iroha.database.sessions.list()).toEqual([])
    })

    test('hides recovery when no recovery token is configured', async () => {
      render(<App />)
      await screen.findByRole('heading', { name: 'Sign in' })

      expect(
        screen.queryByRole('button', { name: 'Recover access with the recovery token' }),
      ).toBeNull()
    })
  })

  describe('session management', () => {
    beforeEach(async () => {
      await start()
      await completeSetup(iroha)
    })

    test('lists this browser and another, and revokes the other', async () => {
      await signInFromAnotherBrowser(iroha)

      render(<App />)
      await screen.findByRole('heading', { name: 'Runtime' })
      await user.click(screen.getByRole('button', { name: 'Settings' }))

      const sessions = await screen.findByRole('heading', { name: 'Sessions' })
      expect(sessions).toBeDefined()
      await screen.findByText('Other Browser')

      const otherRow = screen.getByText('Other Browser').closest('li')
      if (otherRow === null) throw new Error('The other session has no row')
      await user.click(within(otherRow).getByRole('button', { name: /^Revoke session/ }))

      await waitFor(() => expect(screen.queryByText('Other Browser')).toBeNull())
      expect(await iroha.database.sessions.list()).toHaveLength(1)
    })

    test('signs out everywhere and returns to the sign-in screen', async () => {
      await signInFromAnotherBrowser(iroha)

      render(<App />)
      await screen.findByRole('heading', { name: 'Runtime' })
      await user.click(screen.getByRole('button', { name: 'Settings' }))
      await screen.findByRole('heading', { name: 'Sessions' })

      await user.click(screen.getByRole('button', { name: 'Sign out everywhere' }))

      await screen.findByRole('heading', { name: 'Sign in' })
      expect(await iroha.database.sessions.list()).toEqual([])
    })
  })

  describe('recovery', () => {
    beforeEach(async () => {
      await start({ recoveryToken: RECOVERY_TOKEN })
      await completeSetup(iroha)
      await iroha.fetch('/api/v1/auth/sessions', { method: 'DELETE', csrf: await currentCsrf(iroha) })
    })

    test('resets the password from the browser and revokes every session', async () => {
      await signInFromAnotherBrowser(iroha)

      render(<App />)
      await screen.findByRole('heading', { name: 'Sign in' })
      await user.click(screen.getByRole('button', { name: 'Recover access with the recovery token' }))

      await screen.findByRole('heading', { name: 'Recover access' })
      await user.type(screen.getByLabelText('Recovery token'), RECOVERY_TOKEN)
      await user.type(screen.getByLabelText('New password'), 'a replacement password entirely')
      await user.click(screen.getByRole('button', { name: 'Reset password' }))

      await screen.findByRole('heading', { name: 'Password changed' })
      expect(await iroha.database.sessions.list()).toEqual([])

      await user.click(screen.getByRole('button', { name: 'Back to sign in' }))
      await screen.findByRole('heading', { name: 'Sign in' })
      await user.type(screen.getByLabelText('Username'), 'owner')
      await user.type(screen.getByLabelText('Password'), 'a replacement password entirely')
      await user.click(screen.getByRole('button', { name: 'Sign in' }))

      await screen.findByRole('heading', { name: 'Runtime' })
    })

    test('reports a wrong recovery token without changing the password', async () => {
      render(<App />)
      await screen.findByRole('heading', { name: 'Sign in' })
      await user.click(screen.getByRole('button', { name: 'Recover access with the recovery token' }))

      await user.type(screen.getByLabelText('Recovery token'), 'a wrong token')
      await user.type(screen.getByLabelText('New password'), 'a replacement password entirely')
      await user.click(screen.getByRole('button', { name: 'Reset password' }))

      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toContain('Recovery failed')

      const stored = await iroha.database.owner.get()
      expect(stored?.passwordChangedAt).toEqual(stored?.createdAt ?? new Date(0))
    })
  })
})

/** Signs in from a second browser without touching this page's cookie jar. */
async function signInFromAnotherBrowser(iroha: TestApp): Promise<void> {
  const response = await iroha.app.handle(
    new Request('http://iroha.test/api/v1/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://iroha.test',
        'user-agent': 'Other Browser',
      },
      body: JSON.stringify({ username: 'owner', password: PASSWORD }),
    }),
  )

  if (response.status !== 200) throw new Error(`The second browser could not sign in`)
}

async function currentCsrf(iroha: TestApp): Promise<string> {
  const state = (await (await iroha.fetch('/api/v1/auth/state')).json()) as {
    session: { csrfToken: string } | null
  }
  return state.session?.csrfToken ?? ''
}
