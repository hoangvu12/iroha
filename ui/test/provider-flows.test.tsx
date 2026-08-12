import { beforeAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createSecretCipher } from '../../src/crypto/index.ts'
import {
  completeSetup,
  createTestApp,
  fakeKeyProbe,
  TEST_MASTER_KEY,
  type FakeKeyProbe,
  type TestApp,
} from '../../test/support/app.ts'
import { registerDom, useGatewayAsFetch } from './browser.ts'

registerDom()

const { cleanup, render, screen, waitFor, within } = await import('@testing-library/react')
const { default: userEvent } = await import('@testing-library/user-event')
const { default: App } = await import('../src/App')

const UPSTREAM_KEY = 'sk-upstream-secret-value-for-tests'

describe('Provider Connections in the browser', () => {
  let iroha: TestApp
  let probe: FakeKeyProbe
  let restoreFetch: () => void
  let user: ReturnType<typeof userEvent.setup>

  beforeAll(() => {
    registerDom()
  })

  beforeEach(async () => {
    user = userEvent.setup({ delay: null })
    probe = fakeKeyProbe()
    iroha = await createTestApp({ upstreamKeyProbe: probe })
    await completeSetup(iroha)
    restoreFetch = useGatewayAsFetch(iroha)
    document.body.innerHTML = ''
  })

  afterEach(async () => {
    cleanup()
    restoreFetch?.()
    await iroha.dispose()
  })

  const openProviders = async () => {
    render(<App />)
    await screen.findByRole('heading', { name: 'Runtime' })
    await user.click(screen.getByRole('button', { name: 'Providers' }))
    await screen.findByRole('heading', { name: 'Provider Connections' })
  }

  const fillCreateForm = async (fields: { name?: string; baseUrl?: string; key?: string } = {}) => {
    await user.click(screen.getByRole('button', { name: 'New connection' }))
    await screen.findByRole('heading', { name: 'New Provider Connection' })

    await user.type(screen.getByLabelText('Display name'), fields.name ?? 'Example')
    await user.type(screen.getByLabelText('Base URL'), fields.baseUrl ?? 'https://api.example.com/v1')
    await user.type(screen.getByLabelText('Upstream key'), fields.key ?? UPSTREAM_KEY)
    await user.click(screen.getByRole('button', { name: 'Create connection' }))
  }

  test('creates a connection, activates a usable key, and never reveals the key again', async () => {
    await openProviders()
    await fillCreateForm()

    await screen.findByText('Example')
    await screen.findByText('Active')
    expect(screen.getByText(/Tested usable/)).toBeDefined()

    // The key was typed into the page and must not remain anywhere on it.
    expect(document.body.textContent).not.toContain(UPSTREAM_KEY)

    const [stored] = await iroha.database.providers.listConnections()
    const [key] = await iroha.database.providers.listKeys(stored!.id)
    expect(key!.encryptedKey).not.toContain(UPSTREAM_KEY)
    expect(await createSecretCipher(TEST_MASTER_KEY).decrypt(key!.encryptedKey)).toBe(UPSTREAM_KEY)
  })

  test('keeps the form and reports problems when required fields are missing', async () => {
    await openProviders()

    await user.click(screen.getByRole('button', { name: 'New connection' }))
    await user.click(screen.getByRole('button', { name: 'Create connection' }))

    await screen.findAllByText('is required')
    expect(screen.getByRole('heading', { name: 'New Provider Connection' })).toBeDefined()
    expect(await iroha.database.providers.listConnections()).toEqual([])
  })

  test('keeps an inconclusively tested key Unverified until the Owner activates it', async () => {
    probe.respondWith({ verdict: 'inconclusive', reason: 'the provider could not be reached' })

    await openProviders()
    await fillCreateForm()

    await screen.findByText('Unverified')
    expect(screen.getByText(/the provider could not be reached/)).toBeDefined()

    await user.click(screen.getByRole('button', { name: 'Activate' }))

    await screen.findByText('Active')
    expect(screen.queryByText('Unverified')).toBeNull()
  })

  test('tests, disables, and retests the key without losing its identity', async () => {
    probe.respondWith({ verdict: 'inconclusive', reason: 'the provider could not be reached' })

    await openProviders()
    await fillCreateForm()
    await screen.findByText('Unverified')

    await user.click(screen.getByRole('button', { name: 'Disable' }))
    await screen.findByText('Disabled')

    probe.respondWith({ verdict: 'usable', reason: null })
    await user.click(screen.getByRole('button', { name: 'Test' }))

    // A disabled key records the good test but stays disabled until activated.
    await screen.findByText(/Tested usable/)
    expect(screen.getByText('Disabled')).toBeDefined()

    await user.click(screen.getByRole('button', { name: 'Activate' }))
    await screen.findByText('Active')
  })

  test('edits the display name and keeps the connection in place', async () => {
    await openProviders()
    await fillCreateForm({ name: 'Before' })
    await screen.findByText('Before')

    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const nameField = screen.getByLabelText('Display name')
    await user.clear(nameField)
    await user.type(nameField, 'After')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    await screen.findByText('After')
    expect(screen.queryByText('Before')).toBeNull()
    expect((await iroha.database.providers.listConnections())).toHaveLength(1)
  })

  test('duplicates a connection under a new identity', async () => {
    await openProviders()
    await fillCreateForm({ name: 'Original' })
    await screen.findByText('Original')

    await user.click(screen.getByRole('button', { name: 'Duplicate' }))

    await screen.findByText('Original (copy)')
    expect(await iroha.database.providers.listConnections()).toHaveLength(2)
  })

  test('archives a connection and then purges it for good', async () => {
    await openProviders()
    await fillCreateForm()
    await screen.findByText('Example')

    await user.click(screen.getByRole('button', { name: 'Archive' }))

    await screen.findByRole('heading', { name: 'Archived' })
    const archivedSection = screen.getByRole('heading', { name: 'Archived' }).closest('section')
    if (archivedSection === null) throw new Error('The archived section is missing')
    expect(within(archivedSection as HTMLElement).getByText('Example')).toBeDefined()

    await user.click(within(archivedSection as HTMLElement).getByRole('button', { name: 'Purge' }))
    await user.click(
      within(archivedSection as HTMLElement).getByRole('button', { name: 'Confirm purge' }),
    )

    await waitFor(() => expect(screen.queryByText('Example')).toBeNull())
    expect(await iroha.database.providers.listConnections()).toEqual([])
  })

  test('warns persistently about a connection allowed onto plain HTTP', async () => {
    await openProviders()

    await user.click(screen.getByRole('button', { name: 'New connection' }))
    await user.type(screen.getByLabelText('Display name'), 'Local server')
    await user.type(screen.getByLabelText('Base URL'), 'http://localhost:8000/v1')
    await user.type(screen.getByLabelText('Upstream key'), UPSTREAM_KEY)
    await user.click(screen.getByLabelText(/Allow plain HTTP for this connection/))
    await user.click(screen.getByRole('button', { name: 'Create connection' }))

    await screen.findByText('Local server')

    const warning = screen.getByText(/the Upstream Key is sent over plain HTTP/i)
    expect(warning).toBeDefined()
    expect(document.body.textContent).toContain('Insecure HTTP')
  })
})
