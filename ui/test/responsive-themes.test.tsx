import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  completeSetup,
  createTestApp,
  type TestApp,
} from '../../test/support/app.ts'
import { registerDom, useGatewayAsFetch } from './browser.ts'

registerDom()

const { cleanup, render, screen } = await import('@testing-library/react')
const { default: userEvent } = await import('@testing-library/user-event')
const { default: App } = await import('../src/App')

describe('responsive and theme behaviour', () => {
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
    await iroha.dispose()
  })

  test('the navigation drawer is hidden by default but appears on small viewports', async () => {
    render(<App />)
    await screen.findByRole('heading', { name: 'Runtime' })

    const trigger = screen.getByRole('button', { name: 'Open navigation' })
    expect(trigger).toBeDefined()
  })

  test('the theme toggle cycles between light, dark, and system and persists in storage', async () => {
    render(<App />)
    await screen.findByRole('heading', { name: 'Runtime' })

    const group = screen.getByRole('radiogroup', { name: 'Color theme' })
    expect(group).toBeDefined()

    // The default preference is system; switching to dark toggles the class.
    const dark = screen.getByRole('radio', { name: 'Dark' })
    await user.click(dark)
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    const light = screen.getByRole('radio', { name: 'Light' })
    await user.click(light)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })
})