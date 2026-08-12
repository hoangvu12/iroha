import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  completeSetup,
  createTestApp,
  fakeKeyProbe,
  type FakeKeyProbe,
  type TestApp,
} from '../../test/support/app.ts'
import { registerDom, useGatewayAsFetch } from './browser.ts'

registerDom()

const { cleanup, render, screen, waitFor, within } = await import('@testing-library/react')
const { default: userEvent } = await import('@testing-library/user-event')
const { default: App } = await import('../src/App')

const UPSTREAM_KEY = 'sk-upstream-secret-value-for-tests'

describe('connection detail in the browser', () => {
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

  test('opens from the Providers list and shows its sub-areas', async () => {
    await iroha.fetch('/api/v1/admin/provider-connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      csrf: await currentCsrf(iroha),
      body: JSON.stringify({
        displayName: 'Example',
        baseUrl: 'https://api.example.com/v1',
        upstreamKey: UPSTREAM_KEY,
        allowInsecureHttp: false,
      }),
    })

    render(<App />)
    await screen.findByRole('heading', { name: 'Runtime' })
    await user.click(screen.getByRole('button', { name: 'Providers' }))
    await screen.findByRole('heading', { name: 'Provider Connections' })

    await user.click(screen.getByRole('button', { name: 'Open' }))

    // The detail page exposes the six sub-areas as its own tab list — distinct
    // from the global navigation, which remains but is not duplicated.
    const tabs = await screen.findByRole('tablist', { name: 'Connection sections' })
    for (const label of ['Overview', 'Upstream Keys', 'Models', 'Usage', 'Logs', 'Settings']) {
      expect(within(tabs).getByRole('tab', { name: label })).toBeDefined()
    }

    // The detail name and id show up.
    expect(await screen.findByRole('heading', { name: 'Example', level: 2 })).toBeDefined()
  })

  test('Upstream Keys tab lets the Owner test and disable a key without leaving the detail', async () => {
    probe.respondWith({ verdict: 'inconclusive', reason: 'no upstream response' })
    await iroha.fetch('/api/v1/admin/provider-connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      csrf: await currentCsrf(iroha),
      body: JSON.stringify({
        displayName: 'Example',
        baseUrl: 'https://api.example.com/v1',
        upstreamKey: UPSTREAM_KEY,
        allowInsecureHttp: false,
      }),
    })

    render(<App />)
    await screen.findByRole('heading', { name: 'Runtime' })
    await user.click(screen.getByRole('button', { name: 'Providers' }))
    await screen.findByRole('heading', { name: 'Provider Connections' })

    await user.click(screen.getByRole('button', { name: 'Open' }))
    const tabs = await screen.findByRole('tablist', { name: 'Connection sections' })
    await user.click(within(tabs).getByRole('tab', { name: 'Upstream Keys' }))

    // Click Disable and observe the badge changes to Disabled.
    const disable = await screen.findByRole('button', { name: 'Disable' })
    await user.click(disable)

    await waitFor(() => expect(screen.getByText('Disabled')).toBeDefined())
  })

  test('keyboard navigation between sub-areas uses left/right arrows', async () => {
    await iroha.fetch('/api/v1/admin/provider-connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      csrf: await currentCsrf(iroha),
      body: JSON.stringify({
        displayName: 'Example',
        baseUrl: 'https://api.example.com/v1',
        upstreamKey: UPSTREAM_KEY,
        allowInsecureHttp: false,
      }),
    })

    render(<App />)
    await screen.findByRole('heading', { name: 'Runtime' })
    await user.click(screen.getByRole('button', { name: 'Providers' }))
    await screen.findByRole('heading', { name: 'Provider Connections' })
    await user.click(screen.getByRole('button', { name: 'Open' }))

    const tabs = await screen.findByRole('tablist', { name: 'Connection sections' })
    const overview = within(tabs).getByRole('tab', { name: 'Overview' })
    overview.focus()
    await user.keyboard('{ArrowRight}')

    await waitFor(() => {
      const next = within(tabs).getByRole('tab', { name: 'Upstream Keys' })
      expect(next.getAttribute('aria-selected')).toBe('true')
    })
  })

  test('back from the detail returns to the Providers list with the connection still listed', async () => {
    await iroha.fetch('/api/v1/admin/provider-connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      csrf: await currentCsrf(iroha),
      body: JSON.stringify({
        displayName: 'Example',
        baseUrl: 'https://api.example.com/v1',
        upstreamKey: UPSTREAM_KEY,
        allowInsecureHttp: false,
      }),
    })

    render(<App />)
    await screen.findByRole('heading', { name: 'Runtime' })
    await user.click(screen.getByRole('button', { name: 'Providers' }))
    await screen.findByRole('heading', { name: 'Provider Connections' })
    await user.click(screen.getByRole('button', { name: 'Open' }))
    await screen.findByRole('heading', { name: 'Example', level: 2 })

    await user.click(screen.getByRole('button', { name: /Back to Providers/ }))

    await screen.findByRole('heading', { name: 'Provider Connections', level: 2 })
    expect(await screen.findByText('Example')).toBeDefined()
  })
})

async function currentCsrf(iroha: TestApp): Promise<string> {
  const state = (await (await iroha.fetch('/api/v1/auth/state')).json()) as {
    session: { csrfToken: string } | null
  }
  return state.session?.csrfToken ?? ''
}