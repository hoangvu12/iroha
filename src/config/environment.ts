import { isAbsolute, resolve } from 'node:path'
import { redactPostgresUrl, schemeOf } from './redact.ts'

export type DatabaseDialect = 'sqlite' | 'postgres'

export interface SqliteConfiguration {
  readonly dialect: 'sqlite'
  /** `:memory:` or an absolute filesystem path. */
  readonly file: string
  /** True when the database lives only for the lifetime of the process. */
  readonly ephemeral: boolean
  /** Safe to log. */
  readonly describe: string
}

export interface PostgresConfiguration {
  readonly dialect: 'postgres'
  /** The full connection URL, including credentials. Never log this. */
  readonly url: string
  /** Safe to log. */
  readonly describe: string
}

export type DatabaseConfiguration = SqliteConfiguration | PostgresConfiguration

export interface IrohaConfiguration {
  readonly database: DatabaseConfiguration
  /** Encrypts recoverable upstream secrets. Never log this. */
  readonly masterKey: string
  /** Authorizes first-run Owner creation while no Owner exists. */
  readonly setupToken: string | undefined
  /** Enables browser-based Owner password recovery when present. */
  readonly recoveryToken: string | undefined
  readonly shutdownGraceMs: number
  readonly host: string
  readonly port: number
}

export interface ConfigurationProblem {
  readonly variable: string
  readonly message: string
}

/**
 * Every configuration problem found in one pass, so that a deployment can be
 * corrected without a restart-and-rediscover cycle per variable.
 */
export class ConfigurationError extends Error {
  readonly problems: readonly ConfigurationProblem[]

  constructor(problems: readonly ConfigurationProblem[]) {
    super(
      `Iroha cannot start with the current configuration:\n${problems
        .map((problem) => `  - ${problem.variable}: ${problem.message}`)
        .join('\n')}`,
    )
    this.name = 'ConfigurationError'
    this.problems = problems
  }
}

export type EnvironmentSource = Readonly<Record<string, string | undefined>>

/** Long enough that a hand-typed value is not mistaken for a generated secret. */
const MINIMUM_SECRET_LENGTH = 32

/** The literal stand-ins shipped in `.env.example`. */
const PLACEHOLDER_PREFIX = 'replace-with-'

const SUPPORTED_SCHEMES = 'file:, postgres://, or postgresql://'
const DEFAULT_SHUTDOWN_GRACE_MS = 10_000
const MAX_SHUTDOWN_GRACE_MS = 60_000

/**
 * Reads deployment configuration, reporting every current problem together.
 *
 * Throws {@link ConfigurationError} rather than exiting, so that tests and the
 * startup path can decide how a failure is presented.
 */
export function loadConfiguration(source: EnvironmentSource = Bun.env): IrohaConfiguration {
  const problems: ConfigurationProblem[] = []

  const database = readDatabase(source, problems)
  const masterKey = readRequiredSecret(source, 'IROHA_MASTER_KEY', problems)
  const setupToken = readOptionalSecret(source, 'IROHA_SETUP_TOKEN', problems)
  const recoveryToken = readOptionalSecret(source, 'IROHA_RECOVERY_TOKEN', problems)
  const shutdownGraceMs = readShutdownGraceMs(source, problems)
  const host = readHost(source, problems)
  const port = readPort(source, problems)

  if (problems.length > 0 || database === null || masterKey === null) {
    throw new ConfigurationError(problems)
  }

  return { database, masterKey, setupToken, recoveryToken, shutdownGraceMs, host, port }
}

function readDatabase(
  source: EnvironmentSource,
  problems: ConfigurationProblem[],
): DatabaseConfiguration | null {
  const raw = source.DATABASE_URL?.trim()

  if (!raw) {
    problems.push({
      variable: 'DATABASE_URL',
      message: `is required and must use ${SUPPORTED_SCHEMES}`,
    })
    return null
  }

  const scheme = schemeOf(raw)

  if (scheme === null) {
    problems.push({
      variable: 'DATABASE_URL',
      message: `has no URL scheme; use ${SUPPORTED_SCHEMES}`,
    })
    return null
  }

  switch (scheme.toLowerCase()) {
    case 'file':
      return readSqlite(raw, problems)
    case 'postgres':
    case 'postgresql':
      return readPostgres(raw, problems)
    default:
      // The scheme is echoed because it is structural, never secret. The rest
      // of the URL is withheld because it may carry a password.
      problems.push({
        variable: 'DATABASE_URL',
        message: `uses unsupported scheme "${scheme}:"; use ${SUPPORTED_SCHEMES}`,
      })
      return null
  }
}

function readSqlite(raw: string, problems: ConfigurationProblem[]): SqliteConfiguration | null {
  // `file:./x.db`, `file:/var/x.db`, and `file://./x.db` all name a path;
  // `file::memory:` names a process-lifetime database used by tests.
  const withoutScheme = raw.slice(raw.indexOf(':') + 1)
  const path = withoutScheme.startsWith('//') ? withoutScheme.slice(2) : withoutScheme

  if (path === ':memory:') {
    return {
      dialect: 'sqlite',
      file: ':memory:',
      ephemeral: true,
      describe: 'sqlite (in-memory, not persistent)',
    }
  }

  if (path.length === 0) {
    problems.push({
      variable: 'DATABASE_URL',
      message: 'names no SQLite file path; use file:./data/iroha.db',
    })
    return null
  }

  const file = isAbsolute(path) ? path : resolve(process.cwd(), path)
  return {
    dialect: 'sqlite',
    file,
    ephemeral: false,
    describe: `sqlite (${file})`,
  }
}

function readPostgres(raw: string, problems: ConfigurationProblem[]): PostgresConfiguration | null {
  try {
    new URL(raw)
  } catch {
    problems.push({
      variable: 'DATABASE_URL',
      message: 'is not a parseable PostgreSQL URL',
    })
    return null
  }

  return { dialect: 'postgres', url: raw, describe: redactPostgresUrl(raw) }
}

function readRequiredSecret(
  source: EnvironmentSource,
  variable: string,
  problems: ConfigurationProblem[],
): string | null {
  const raw = source[variable]?.trim()

  if (!raw) {
    problems.push({
      variable,
      message: `is required and must be at least ${MINIMUM_SECRET_LENGTH} characters`,
    })
    return null
  }

  return validateSecret(raw, variable, problems)
}

function readOptionalSecret(
  source: EnvironmentSource,
  variable: string,
  problems: ConfigurationProblem[],
): string | undefined {
  const raw = source[variable]?.trim()
  if (!raw) return undefined
  return validateSecret(raw, variable, problems) ?? undefined
}

function validateSecret(
  value: string,
  variable: string,
  problems: ConfigurationProblem[],
): string | null {
  if (value.startsWith(PLACEHOLDER_PREFIX)) {
    problems.push({
      variable,
      message: 'still holds the .env.example placeholder; generate a real secret',
    })
    return null
  }

  if (value.length < MINIMUM_SECRET_LENGTH) {
    problems.push({
      variable,
      message: `must be at least ${MINIMUM_SECRET_LENGTH} characters`,
    })
    return null
  }

  return value
}

function readShutdownGraceMs(source: EnvironmentSource, problems: ConfigurationProblem[]): number {
  const raw = source.IROHA_SHUTDOWN_GRACE_MS?.trim()
  if (raw === undefined) return DEFAULT_SHUTDOWN_GRACE_MS
  if (!/^\d+$/.test(raw)) {
    problems.push({
      variable: 'IROHA_SHUTDOWN_GRACE_MS',
      message: 'must be a whole number of milliseconds between 0 and 60000',
    })
    return DEFAULT_SHUTDOWN_GRACE_MS
  }

  const value = Number(raw)
  if (value > MAX_SHUTDOWN_GRACE_MS) {
    problems.push({
      variable: 'IROHA_SHUTDOWN_GRACE_MS',
      message: `must be between 0 and ${MAX_SHUTDOWN_GRACE_MS} milliseconds`,
    })
    return DEFAULT_SHUTDOWN_GRACE_MS
  }

  return value
}

function readHost(source: EnvironmentSource, problems: ConfigurationProblem[]): string {
  const raw = source.HOST?.trim()
  if (raw === undefined) return '0.0.0.0'

  if (raw.length === 0) {
    problems.push({ variable: 'HOST', message: 'is set but empty; remove it or give an address' })
    return '0.0.0.0'
  }

  return raw
}

function readPort(source: EnvironmentSource, problems: ConfigurationProblem[]): number {
  const raw = source.PORT?.trim()
  if (!raw) return 3000

  // A port is not secret, so echoing the rejected value helps the Owner.
  if (!/^\d+$/.test(raw)) {
    problems.push({ variable: 'PORT', message: `must be a whole number, not "${raw}"` })
    return 3000
  }

  const port = Number(raw)
  if (port < 1 || port > 65535) {
    problems.push({ variable: 'PORT', message: `must be between 1 and 65535, not ${port}` })
    return 3000
  }

  return port
}
