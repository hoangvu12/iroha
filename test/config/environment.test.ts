import { describe, expect, test } from 'bun:test'
import { ConfigurationError, loadConfiguration } from '../../src/config/environment.ts'

const MASTER_KEY = 'a'.repeat(64)
const SETUP_TOKEN = 'b'.repeat(64)

function valid(overrides: Record<string, string | undefined> = {}) {
  return { DATABASE_URL: 'file:./data/iroha.db', IROHA_MASTER_KEY: MASTER_KEY, ...overrides }
}

function problemsFrom(source: Record<string, string | undefined>) {
  try {
    loadConfiguration(source)
  } catch (error) {
    if (error instanceof ConfigurationError) return error
    throw error
  }
  throw new Error('expected loadConfiguration to reject this environment')
}

describe('required configuration', () => {
  test('accepts a minimal valid environment', () => {
    const config = loadConfiguration(valid())

    expect(config.database.dialect).toBe('sqlite')
    expect(config.masterKey).toBe(MASTER_KEY)
    expect(config.setupToken).toBeUndefined()
    expect(config.recoveryToken).toBeUndefined()
    expect(config.host).toBe('0.0.0.0')
    expect(config.port).toBe(3000)
    expect(config.shutdownGraceMs).toBe(10_000)
  })

  test('reports every missing required value together', () => {
    const error = problemsFrom({})

    expect(error.problems.map((problem) => problem.variable).sort()).toEqual([
      'DATABASE_URL',
      'IROHA_MASTER_KEY',
    ])
  })

  test('reports database, secret, and port problems in one pass', () => {
    const error = problemsFrom({
      DATABASE_URL: 'mysql://iroha:hunter2@db.example.com/iroha',
      IROHA_MASTER_KEY: 'short',
      PORT: 'eighty',
    })

    expect(error.problems.map((problem) => problem.variable).sort()).toEqual([
      'DATABASE_URL',
      'IROHA_MASTER_KEY',
      'PORT',
    ])
  })

  test('rejects the placeholders shipped in .env.example', () => {
    const error = problemsFrom(
      valid({ IROHA_MASTER_KEY: 'replace-with-a-stable-random-secret' }),
    )

    expect(error.problems).toHaveLength(1)
    expect(error.problems[0]?.variable).toBe('IROHA_MASTER_KEY')
  })
})

describe('secret redaction', () => {
  test('no secret value appears in the aggregated error message', () => {
    const error = problemsFrom({
      DATABASE_URL: 'redis://user:s3cr3t-database-password@cache.example.com',
      IROHA_MASTER_KEY: 'weak-master-key-value',
      IROHA_SETUP_TOKEN: 'weak-setup-token-value',
      IROHA_RECOVERY_TOKEN: 'weak-recovery-token-value',
    })

    const rendered = `${error.message}\n${JSON.stringify(error.problems)}`

    for (const secret of [
      's3cr3t-database-password',
      'cache.example.com',
      'weak-master-key-value',
      'weak-setup-token-value',
      'weak-recovery-token-value',
    ]) {
      expect(rendered).not.toContain(secret)
    }
  })

  test('an unsupported scheme is named without echoing the rest of the URL', () => {
    const error = problemsFrom(
      valid({ DATABASE_URL: 'mysql://iroha:hunter2@db.example.com/iroha' }),
    )

    expect(error.message).toContain('mysql:')
    expect(error.message).not.toContain('hunter2')
    expect(error.message).not.toContain('db.example.com')
  })

  test('a scheme-less value is rejected without echoing it', () => {
    const error = problemsFrom(valid({ DATABASE_URL: 'this-might-be-a-pasted-secret' }))

    expect(error.message).not.toContain('this-might-be-a-pasted-secret')
    expect(error.message).toContain('no URL scheme')
  })

  test('a valid PostgreSQL URL is described without its password', () => {
    const config = loadConfiguration(
      valid({ DATABASE_URL: 'postgres://iroha:hunter2@db.example.com:5432/iroha' }),
    )

    expect(config.database.describe).not.toContain('hunter2')
    expect(config.database.describe).toContain('db.example.com')
  })
})

describe('database URL schemes', () => {
  test.each([
    ['postgres://iroha@localhost/iroha', 'postgres'],
    ['postgresql://iroha@localhost/iroha', 'postgres'],
    ['POSTGRES://iroha@localhost/iroha', 'postgres'],
    ['file:./data/iroha.db', 'sqlite'],
    ['file:/var/lib/iroha/iroha.db', 'sqlite'],
    ['file::memory:', 'sqlite'],
  ] as const)('%s selects %s', (url, dialect) => {
    expect(loadConfiguration(valid({ DATABASE_URL: url })).database.dialect).toBe(dialect)
  })

  test.each(['mysql://localhost/iroha', 'sqlite://iroha.db', 'http://localhost:5432', 'libsql://x'])(
    '%s is rejected',
    (url) => {
      expect(problemsFrom(valid({ DATABASE_URL: url })).problems[0]?.variable).toBe('DATABASE_URL')
    },
  )

  test('a relative SQLite path is resolved against the working directory', () => {
    const config = loadConfiguration(valid({ DATABASE_URL: 'file:./data/iroha.db' }))

    if (config.database.dialect !== 'sqlite') throw new Error('expected SQLite')
    expect(config.database.file.startsWith(process.cwd())).toBe(true)
    expect(config.database.ephemeral).toBe(false)
  })

  test('an in-memory SQLite database is marked non-persistent', () => {
    const config = loadConfiguration(valid({ DATABASE_URL: 'file::memory:' }))

    if (config.database.dialect !== 'sqlite') throw new Error('expected SQLite')
    expect(config.database.ephemeral).toBe(true)
    expect(config.database.describe).toContain('not persistent')
  })
})

describe('optional configuration', () => {
  test('accepts setup and recovery tokens', () => {
    const config = loadConfiguration(
      valid({ IROHA_SETUP_TOKEN: SETUP_TOKEN, IROHA_RECOVERY_TOKEN: 'c'.repeat(40) }),
    )

    expect(config.setupToken).toBe(SETUP_TOKEN)
    expect(config.recoveryToken).toBe('c'.repeat(40))
  })

  test('a weak optional token is still rejected', () => {
    const error = problemsFrom(valid({ IROHA_RECOVERY_TOKEN: 'short' }))

    expect(error.problems[0]?.variable).toBe('IROHA_RECOVERY_TOKEN')
  })

  test('host and port override their defaults', () => {
    const config = loadConfiguration(valid({ HOST: '127.0.0.1', PORT: '8080' }))

    expect(config.host).toBe('127.0.0.1')
    expect(config.port).toBe(8080)
  })

  test('shutdown grace is bounded and accepts zero', () => {
    expect(loadConfiguration(valid({ IROHA_SHUTDOWN_GRACE_MS: '0' })).shutdownGraceMs).toBe(0)
    expect(loadConfiguration(valid({ IROHA_SHUTDOWN_GRACE_MS: '60000' })).shutdownGraceMs).toBe(60_000)
  })

  test.each(['0', '65536', '-1', '3000.5', 'eighty'])('PORT=%s is rejected', (port) => {
    expect(problemsFrom(valid({ PORT: port })).problems[0]?.variable).toBe('PORT')
  })

  test.each(['-1', '60001', 'thirty', '2.5', ''])(
    'IROHA_SHUTDOWN_GRACE_MS=%s is rejected',
    (value) => {
      const error = problemsFrom(valid({ IROHA_SHUTDOWN_GRACE_MS: value }))
      expect(error.problems[0]?.variable).toBe('IROHA_SHUTDOWN_GRACE_MS')
    },
  )
})
