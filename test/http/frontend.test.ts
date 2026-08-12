import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../../src/http/app.ts'
import { ReadinessState } from '../../src/http/readiness.ts'
import { OwnerIdentity } from '../../src/identity/index.ts'
import { sqliteEngine } from '../persistence/engines.ts'
import { gatewayKeyRegistryFor, providerRegistryFor } from '../support/app.ts'

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/** A directory shaped like a real `ui/dist`, plus a secret sitting beside it. */
function builtFrontend(): { directory: string; secretPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'iroha-frontend-'))
  const directory = join(root, 'dist')
  mkdirSync(join(directory, 'assets'), { recursive: true })
  writeFileSync(join(directory, 'index.html'), '<!doctype html><title>Iroha</title>')
  writeFileSync(join(directory, 'assets', 'app-abc123.js'), 'console.log("iroha")')

  const secretPath = join(root, '.env')
  writeFileSync(secretPath, 'IROHA_MASTER_KEY=super-secret-master-key')

  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  return { directory, secretPath }
}

async function appWith(frontendDirectory: string | undefined) {
  const { database, dispose } = await sqliteEngine.open()
  cleanups.push(dispose)

  const readiness = new ReadinessState()
  readiness.markMigrated()

  const app = createApp({
    database,
    readiness,
    identity: new OwnerIdentity({ database }),
    providers: providerRegistryFor(database),
    gatewayKeys: gatewayKeyRegistryFor(database),
    frontendDirectory,
  })
  return (path: string) => app.handle(new Request(`http://iroha.test${path}`))
}

describe('management UI serving', () => {
  test('serves the entry document at the root', async () => {
    const { directory } = builtFrontend()
    const get = await appWith(directory)

    const response = await get('/')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(await response.text()).toContain('<title>Iroha</title>')
  })

  test('serves hashed assets as immutable', async () => {
    const { directory } = builtFrontend()
    const get = await appWith(directory)

    const response = await get('/assets/app-abc123.js')

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('immutable')
    expect(await response.text()).toContain('iroha')
  })

  test('never caches the entry document', async () => {
    const { directory } = builtFrontend()
    const get = await appWith(directory)

    expect((await get('/')).headers.get('cache-control')).toBe('no-cache')
  })

  test('falls back to the entry document for client-side routes', async () => {
    const { directory } = builtFrontend()
    const get = await appWith(directory)

    const response = await get('/providers/openai-main/models')

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<title>Iroha</title>')
  })

  test('health routes are not shadowed by the fallback', async () => {
    const { directory } = builtFrontend()
    const get = await appWith(directory)

    expect(await (await get('/health/live')).json()).toEqual({ status: 'alive' })
  })

  test.each([
    '/../.env',
    '/%2e%2e/.env',
    '/assets/../../.env',
    '/..%2f.env',
    '/%2e%2e%2f%2e%2e%2f.env',
  ])('refuses to read outside the build directory: %s', async (path) => {
    const { directory } = builtFrontend()
    const get = await appWith(directory)

    const body = await (await get(path)).text()

    expect(body).not.toContain('super-secret-master-key')
    expect(body).toContain('<title>Iroha</title>')
  })

  test('explains an unbuilt UI instead of returning an empty page', async () => {
    const get = await appWith(join(tmpdir(), 'iroha-never-built'))

    const response = await get('/')

    expect(response.status).toBe(503)
    expect(await response.text()).toContain('bun run build')
  })
})
