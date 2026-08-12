import { Database as BunSqlite } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigurationError } from '../../src/config/environment.ts'
import { startIroha, type RunningIroha } from '../../src/runtime/startup.ts'

import { testPasswordHasher } from '../support/identity.ts'

const MASTER_KEY = 'a'.repeat(64)
const SETUP_TOKEN = 'b'.repeat(64)

const temporaryDirectories: string[] = []
const running: RunningIroha[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map((iroha) => iroha.stop().catch(() => undefined)))
  for (const directory of temporaryDirectories.splice(0)) {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // Windows may still hold the SQLite WAL; temp cleanup handles it.
    }
  }
})

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'iroha-startup-'))
  temporaryDirectories.push(directory)
  return directory
}

/**
 * A port nothing is listening on. Bun assigns one, then releases it, which is
 * close enough for a single-process suite and avoids a fixed-port collision.
 */
async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response('') })
  const { port } = server
  await server.stop(true)

  if (port === undefined) throw new Error('Bun did not assign a port')
  return port
}

async function start(environment: Record<string, string | undefined>) {
  const iroha = await startIroha({
    // A setup token is present unless a test deliberately removes it, since
    // an unclaimed installation requires one.
    environment: { IROHA_SETUP_TOKEN: SETUP_TOKEN, ...environment },
    // Point away from any built UI so these tests exercise the API alone.
    frontendDirectory: join(temporaryDirectory(), 'no-frontend'),
    log: () => undefined,
    passwordHasher: testPasswordHasher,
  })
  running.push(iroha)
  return iroha
}

describe('startup ordering', () => {
  test('migrates before the port accepts traffic', async () => {
    const file = join(temporaryDirectory(), 'iroha.db')
    const port = await freePort()

    const iroha = await start({
      DATABASE_URL: `file:${file}`,
      IROHA_MASTER_KEY: MASTER_KEY,
      HOST: '127.0.0.1',
      PORT: String(port),
    })

    // The very first request a client can make already sees a migrated schema.
    const response = await fetch(`${iroha.url}/health/ready`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ready', database: { dialect: 'sqlite' } })

    await expect(iroha.database.settings.list()).resolves.toEqual([])
  })

  test('persists data written through the running application', async () => {
    const file = join(temporaryDirectory(), 'iroha.db')

    const first = await start({
      DATABASE_URL: `file:${file}`,
      IROHA_MASTER_KEY: MASTER_KEY,
      HOST: '127.0.0.1',
      PORT: String(await freePort()),
    })
    await first.database.settings.put('retention', { days: 30 })
    await first.stop()

    const second = await start({
      DATABASE_URL: `file:${file}`,
      IROHA_MASTER_KEY: MASTER_KEY,
      HOST: '127.0.0.1',
      PORT: String(await freePort()),
    })

    expect((await second.database.settings.get('retention'))?.value).toEqual({ days: 30 })
  })

  test('shutdown closes the runtime after the configured grace period', async () => {
    const iroha = await start({
      DATABASE_URL: 'file::memory:',
      IROHA_MASTER_KEY: MASTER_KEY,
      IROHA_SHUTDOWN_GRACE_MS: '0',
      HOST: '127.0.0.1',
      PORT: String(await freePort()),
    })

    const stopping = iroha.stop()
    await stopping

    await expect(fetch(`${iroha.url}/health/live`)).rejects.toThrow()
  })

  test('stop() is safe to call more than once', async () => {
    const iroha = await start({
      DATABASE_URL: 'file::memory:',
      IROHA_MASTER_KEY: MASTER_KEY,
      HOST: '127.0.0.1',
      PORT: String(await freePort()),
    })

    await iroha.stop()
    await expect(iroha.stop()).resolves.toBeUndefined()
  })
})

describe('the setup token requirement', () => {
  test('an unclaimed installation refuses to start without one', async () => {
    const port = await freePort()

    const failure = start({
      DATABASE_URL: `file:${join(temporaryDirectory(), 'iroha.db')}`,
      IROHA_MASTER_KEY: MASTER_KEY,
      IROHA_SETUP_TOKEN: undefined,
      HOST: '127.0.0.1',
      PORT: String(port),
    })

    await expect(failure).rejects.toThrow(/IROHA_SETUP_TOKEN/)
    await expect(failure).rejects.toBeInstanceOf(ConfigurationError)
    await expect(fetch(`http://127.0.0.1:${port}/health/live`)).rejects.toThrow()
  })

  test('a claimed installation starts without one, and setup stays closed', async () => {
    const file = join(temporaryDirectory(), 'iroha.db')

    const first = await start({
      DATABASE_URL: `file:${file}`,
      IROHA_MASTER_KEY: MASTER_KEY,
      HOST: '127.0.0.1',
      PORT: String(await freePort()),
    })

    const claimed = await fetch(`${first.url}/api/v1/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: first.url },
      body: JSON.stringify({
        username: 'owner',
        password: 'correct horse battery staple',
        setupToken: SETUP_TOKEN,
      }),
    })
    expect(claimed.status).toBe(201)
    await first.stop()

    const second = await start({
      DATABASE_URL: `file:${file}`,
      IROHA_MASTER_KEY: MASTER_KEY,
      IROHA_SETUP_TOKEN: undefined,
      HOST: '127.0.0.1',
      PORT: String(await freePort()),
    })

    const state = await fetch(`${second.url}/api/v1/auth/state`)
    expect(await state.json()).toMatchObject({ setupRequired: false, authenticated: false })
  })

  test('an Owner created before a restart can still sign in after it', async () => {
    const file = join(temporaryDirectory(), 'iroha.db')

    const first = await start({
      DATABASE_URL: `file:${file}`,
      IROHA_MASTER_KEY: MASTER_KEY,
      HOST: '127.0.0.1',
      PORT: String(await freePort()),
    })
    await fetch(`${first.url}/api/v1/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: first.url },
      body: JSON.stringify({
        username: 'owner',
        password: 'correct horse battery staple',
        setupToken: SETUP_TOKEN,
      }),
    })
    await first.stop()

    const second = await start({
      DATABASE_URL: `file:${file}`,
      IROHA_MASTER_KEY: MASTER_KEY,
      HOST: '127.0.0.1',
      PORT: String(await freePort()),
    })

    const login = await fetch(`${second.url}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: second.url },
      body: JSON.stringify({ username: 'owner', password: 'correct horse battery staple' }),
    })

    expect(login.status).toBe(200)
    expect(login.headers.getSetCookie()[0]).toStartWith('iroha_session=')
  })
})

describe('startup failure', () => {
  test('invalid configuration stops startup and binds no port', async () => {
    const port = await freePort()

    const failure = start({
      DATABASE_URL: 'mysql://localhost/iroha',
      IROHA_MASTER_KEY: MASTER_KEY,
      HOST: '127.0.0.1',
      PORT: String(port),
    })

    await expect(failure).rejects.toBeInstanceOf(ConfigurationError)
    await expect(fetch(`http://127.0.0.1:${port}/health/live`)).rejects.toThrow()
  })

  test('a failing migration stops startup and binds no port', async () => {
    const file = join(temporaryDirectory(), 'occupied.db')

    // A conflicting table of the same name makes the initial migration fail
    // the way a hand-edited or partially upgraded database would.
    const existing = new BunSqlite(file, { create: true })
    existing.exec('create table settings (unrelated text)')
    existing.close()

    const port = await freePort()

    const failure = start({
      DATABASE_URL: `file:${file}`,
      IROHA_MASTER_KEY: MASTER_KEY,
      HOST: '127.0.0.1',
      PORT: String(port),
    })

    await expect(failure).rejects.toThrow(/Migrating/)
    await expect(fetch(`http://127.0.0.1:${port}/health/live`)).rejects.toThrow()
  })

  test('a failed startup leaves no open database handle behind', async () => {
    const file = join(temporaryDirectory(), 'occupied.db')

    const existing = new BunSqlite(file, { create: true })
    existing.exec('create table settings (unrelated text)')
    existing.close()

    await expect(
      start({
        DATABASE_URL: `file:${file}`,
        IROHA_MASTER_KEY: MASTER_KEY,
        HOST: '127.0.0.1',
        PORT: String(await freePort()),
      }),
    ).rejects.toThrow()

    // The file is reopenable, which it would not be if Iroha still held it.
    const reopened = new BunSqlite(file)
    expect(reopened.query('select count(*) as count from settings').get()).toEqual({ count: 0 })
    reopened.close()
  })
})
