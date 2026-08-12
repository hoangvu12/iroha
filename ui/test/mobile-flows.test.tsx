import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  completeSetup,
  createTestApp,
  type TestApp,
} from '../../test/support/app.ts'
import { registerDom, useGatewayAsFetch } from './browser.ts'

registerDom()

const { cleanup, render, screen, waitFor } = await import('@testing-library/react')
const { default: userEvent } = await import('@testing-library/user-event')
const { default: App } = await import('../src/App')

const PASSWORD = 'correct horse battery staple'

/**
 * Mobile-shaped flows in the management UI.
 *
 * The Owner's phone is an emergency console: the navigation collapses into a
 * drawer, every primary area must remain reachable, and the dangerous
 * actions (revoke all sessions, revoke another device) must be one tap from
 * the primary navigation rather than buried behind menus.
 */
describe('mobile management flows', () => {
  let iroha: TestApp
  let restoreFetch: () => void
  let user: ReturnType<typeof userEvent.setup>

  beforeAll(() => {
    registerDom()
  })

  beforeEach(async () => {
    user = userEvent.setup({ delay: null })
    iroha = await createTestApp({})
    await completeSetup(iroha)
    restoreFetch = useGatewayAsFetch(iroha)
    document.body.innerHTML = ''
  })

  afterEach(async () => {
    cleanup()
    restoreFetch?.()
    await iroha?.dispose()
  })

  test('the drawer exposes every primary area on small viewports', async () => {
    render(<App />)
    await screen.findByRole('heading', { name: 'Runtime' })

    const trigger = screen.getByRole('button', { name: 'Open navigation' })
    await user.click(trigger)

    for (const label of ['Overview', 'Providers', 'Gateway Keys', 'Requests', 'Audit', 'Settings']) {
      const drawer = screen.getByRole('dialog', { name: 'Navigation' })
      const button = (await screen.findAllByRole('button', { name: label })).at(-1)!
      expect(button).toBeDefined()
      expect(drawer.contains(button)).toBe(true)
    }
  })

  test('settings "Sign out everywhere" on mobile revokes every session', async () => {
    await signInFromAnotherBrowser(iroha)
    const sessionsBefore = await iroha.database.sessions.list()
    expect(sessionsBefore).toHaveLength(2)

    render(<App />)
    await screen.findByRole('heading', { name: 'Runtime' })

    // Open the navigation drawer (mobile-only affordance) and step into
    // Settings from there so the path matches a phone owner's flow.
    await user.click(screen.getByRole('button', { name: 'Open navigation' }))
    const settingsButton = (await screen.findAllByRole('button', { name: 'Settings' })).at(-1)!
    await user.click(settingsButton)
    await screen.findByRole('heading', { name: 'Sessions' })

    await user.click(screen.getByRole('button', { name: 'Sign out everywhere' }))

    await waitFor(async () => {
      expect(await iroha.database.sessions.list()).toHaveLength(0)
    })
    await waitFor(async () => {
      expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeDefined()
    })
  })

  test('revoking a stolen session from settings works without leaving the page', async () => {
    await signInFromAnotherBrowser(iroha)

    render(<App />)
    await screen.findByRole('heading', { name: 'Runtime' })

    await user.click(screen.getByRole('button', { name: 'Open navigation' }))
    const settingsButton = (await screen.findAllByRole('button', { name: 'Settings' })).at(-1)!
    await user.click(settingsButton)
    await screen.findByRole('heading', { name: 'Sessions' })

    await screen.findByText('Other Browser')
    const stolenRow = screen.getByText('Other Browser').closest('li')
    if (stolenRow === null) throw new Error('The other session is missing')
    await user.click((stolenRow as HTMLElement).querySelector('button')!)
    await waitFor(() => expect(screen.queryByText('Other Browser')).toBeNull())
    expect(await iroha.database.sessions.list()).toHaveLength(1)
  })
})

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
