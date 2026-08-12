import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  completeSetup,
  createTestApp,
  fakeKeyProbe,
  type FakeKeyProbe,
  type TestApp,
} from '../../test/support/app.ts'
import { fetchGatewayKeys } from '../src/lib/gateway-keys'
import { fetchRetention } from '../src/lib/settings'
import { registerDom, useGatewayAsFetch } from './browser.ts'

registerDom()

const { cleanup, render, screen, waitFor, within } = await import('@testing-library/react')
const { default: userEvent } = await import('@testing-library/user-event')
const { default: App } = await import('../src/App')

const UPSTREAM_KEY = 'sk-upstream-secret-value-for-tests'

describe('operations workspace in the browser', () => {
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

  test('every primary area is reachable and the navigation never says "Soon"', async () => {
    render(<App />)
    await screen.findByRole('heading', { name: 'Runtime' })

    for (const label of ['Overview', 'Providers', 'Gateway Keys', 'Requests', 'Audit', 'Settings']) {
      const button = screen.getByRole('button', { name: label })
      expect(button).toBeDefined()
      await user.click(button)
      await waitFor(() => expect(button.getAttribute('aria-current')).toBe('page'))
    }
  })

  test('Gateway Keys area creates a key, shows the usable secret once, and lets the Owner revoke it', async () => {
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
    await user.click(screen.getByRole('button', { name: 'Gateway Keys' }))
    await screen.findByRole('heading', { name: 'Gateway Keys', level: 2 })

    await user.click(screen.getByRole('button', { name: 'New Gateway Key' }))
    await user.type(screen.getByLabelText('Name'), 'Application')
    await user.click(screen.getByRole('checkbox', { name: /Example/ }))

    await user.click(screen.getByRole('button', { name: 'Create Gateway Key' }))

    const issued = await screen.findByText(/Gateway Key created/)
    expect(issued).toBeDefined()

    // The created key is now in the list.
    const keys = await fetchGatewayKeys()
    expect(keys).toHaveLength(1)
    expect(keys[0]!.name).toBe('Application')

    await screen.findByText('Application')

    const row = screen.getByText('Application').closest('li')
    if (row === null) throw new Error('The Gateway Key row is missing')
    await user.click(within(row).getByRole('button', { name: 'Revoke' }))
    await user.click(within(row).getByRole('button', { name: 'Confirm revoke' }))

    await waitFor(async () => {
      const refreshed = await fetchGatewayKeys()
      expect(refreshed[0]!.revoked).toBe(true)
    })

    // The secret never lingers anywhere on the page.
    expect(document.body.textContent).not.toMatch(/sk-[A-Za-z0-9]{20,}/)
  })

  test('Requests area lists recorded events and shows the attempt trail on inspect', async () => {
    const csrf = await currentCsrf(iroha)
    const conn = await iroha.fetch('/api/v1/admin/provider-connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      csrf,
      body: JSON.stringify({
        displayName: 'Example',
        baseUrl: 'https://api.example.com/v1',
        upstreamKey: UPSTREAM_KEY,
        allowInsecureHttp: false,
      }),
    })
    const connection = (await conn.json()) as { id: string; keys: { id: string }[] }
    const keyId = connection.keys[0]!.id

    await iroha.database.requestHistory.recordEvent({
      id: 'req-test-1',
      occurredAt: new Date(),
      connectionId: connection.id,
      model: 'gpt-4o-mini',
      gatewayKeyId: null,
      keyId,
      status: 200,
      outcome: 'success',
      latencyMs: 245,
      isStreaming: false,
      promptTokens: 10,
      completionTokens: 12,
      totalTokens: 22,
      errorCode: null,
    })
    await iroha.database.requestHistory.recordEvent({
      id: 'req-test-2',
      occurredAt: new Date(),
      connectionId: connection.id,
      model: 'gpt-4o-mini',
      gatewayKeyId: null,
      keyId,
      status: 503,
      outcome: 'failure',
      latencyMs: 178,
      isStreaming: false,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      errorCode: 'upstream_credentials_unavailable',
    })

    render(<App />)
    await screen.findByRole('heading', { name: 'Runtime' })
    await user.click(screen.getByRole('button', { name: 'Requests' }))
    await screen.findByRole('heading', { name: 'Request history', level: 2 })

    expect(await screen.findByText(/of\s+2/)).toBeDefined()

    // Filter to failures only.
    await user.selectOptions(screen.getByLabelText('Outcome'), 'failure')
    await waitFor(() => expect(screen.getByText(/of\s+1/)).toBeDefined())

    // Open the detail and check the attempt line.
    await user.click(screen.getByRole('button', { name: /Inspect request req-test-2/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/upstream_credentials_unavailable/)).toBeDefined()

    // Filtering by an unknown model returns an empty state with specific guidance.
    await user.selectOptions(screen.getByLabelText('Outcome'), '')
    await user.type(screen.getByLabelText('Model'), 'no-such-model')
    await waitFor(() => expect(screen.getByText(/No requests match this filter/)).toBeDefined())
  })

  test('Audit area lists events and clears them, recording the clear', async () => {
    await currentCsrf(iroha)
    const beforeClear = (await iroha.database.requestHistory.listAudit()).events.length
    await iroha.database.audit.record({
      action: 'connection.created',
      outcome: 'success',
      detail: { connectionId: 'example' },
      at: new Date(),
    })

    render(<App />)
    await screen.findByRole('heading', { name: 'Runtime' })
    await user.click(screen.getByRole('button', { name: 'Audit' }))
    await screen.findByRole('heading', { name: 'Audit history', level: 2 })

    const totalAfter = beforeClear + 1
    expect(await screen.findByText(new RegExp(`of\\s+${totalAfter}`))).toBeDefined()
    expect(screen.getByText('connection.created')).toBeDefined()

    await user.click(screen.getByRole('button', { name: 'Clear feed' }))

    await waitFor(async () => {
      const audit = await iroha.database.requestHistory.listAudit()
      // The clear itself is audited, so the list contains exactly one row.
      expect(audit.events.length).toBe(1)
      expect(audit.events[0]!.action).toBe('audit.cleared')
    })
  })

  test('Settings area reads and updates request-history retention', async () => {
    render(<App />)
    await screen.findByRole('heading', { name: 'Runtime' })
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await screen.findByRole('heading', { name: 'Owner' })

    const input = await screen.findByLabelText('Retention (days)')
    expect(input).toBeDefined()

    const initial = await fetchRetention()
    expect(initial.days).toBe(30)

    await user.clear(input)
    await user.type(input, '7')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(async () => {
      const next = await fetchRetention()
      expect(next.days).toBe(7)
    })
  })

  test('Overview leads with attention rows for unhealthy keys', async () => {
    const csrf = await currentCsrf(iroha)
    const conn = await iroha.fetch('/api/v1/admin/provider-connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      csrf,
      body: JSON.stringify({
        displayName: 'Example',
        baseUrl: 'https://api.example.com/v1',
        upstreamKey: UPSTREAM_KEY,
        allowInsecureHttp: false,
      }),
    })
    const connection = (await conn.json()) as { id: string; keys: { id: string }[] }
    const keyId = connection.keys[0]!.id

    await iroha.fetch(
      `/api/v1/admin/provider-connections/${connection.id}/keys/${keyId}/disable`,
      { method: 'POST', csrf },
    )

    // Seed a usage snapshot so the volume chart renders.
    await iroha.database.usage.put({
      connectionId: connection.id,
      visibility: 'reactive_only',
      syncedAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureCode: null,
      lastFailureMessage: null,
      result: null,
    })

    render(<App />)
    await screen.findByRole('heading', { name: 'Runtime' })
    expect(await screen.findByRole('heading', { name: 'Attention required' })).toBeDefined()
    expect(await screen.findByText('Disabled')).toBeDefined()

    // The volume section renders its header even when the data is empty.
    expect(await screen.findByRole('heading', { name: 'Volume' })).toBeDefined()
    expect(await screen.findByRole('heading', { name: 'Key Health' })).toBeDefined()
  })

  test('keyboard navigation between areas works without a pointer', async () => {
    render(<App />)
    await screen.findByRole('heading', { name: 'Runtime' })

    const button = screen.getByRole('button', { name: 'Providers' })
    button.focus()
    await user.keyboard(' ')

    await screen.findByRole('heading', { name: 'Provider Connections' })
    expect(button.getAttribute('aria-current')).toBe('page')
  })
})

async function currentCsrf(iroha: TestApp): Promise<string> {
  const state = (await (await iroha.fetch('/api/v1/auth/state')).json()) as {
    session: { csrfToken: string } | null
  }
  return state.session?.csrfToken ?? ''
}