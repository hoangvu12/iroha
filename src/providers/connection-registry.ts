import { randomBytes } from 'node:crypto'
import { SecretCipherError, type SecretCipher } from '../crypto/index.ts'
import type {
  ConnectionCapabilities,
  Database,
  KeyProbeVerdict,
  ProviderConnectionRecord,
  UpstreamKeyHealth,
  UpstreamKeyPatch,
  UpstreamKeyRecord,
} from '../persistence/index.ts'
import { systemClock, type Clock } from '../runtime/clock.ts'
import type { UpstreamKeyProbe } from './key-probe.ts'

export interface FieldProblem {
  readonly field: string
  readonly message: string
}

export type ProviderFailure =
  | { readonly code: 'connection_not_found' }
  | { readonly code: 'key_not_found' }
  /** The connection is archived; only duplication and purge still apply to it. */
  | { readonly code: 'connection_archived' }
  /** The Owner has disabled the connection; it serves no inference. */
  | { readonly code: 'connection_disabled' }
  /** No Upstream Key on the connection is currently eligible to serve. */
  | { readonly code: 'no_eligible_key' }
  /** Purge is archive-first: only an archived connection can be purged. */
  | { readonly code: 'not_archived' }
  /** Encrypted material could not be read; the master key likely changed. */
  | { readonly code: 'stored_key_unreadable' }
  | { readonly code: 'validation_failed'; readonly problems: readonly FieldProblem[] }

export type ProviderResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ProviderFailure }

/** What the Owner may see about an Upstream Key. Never the key itself. */
export interface KeyView {
  readonly id: string
  readonly health: UpstreamKeyHealth
  readonly lastProbe: {
    readonly at: Date
    readonly verdict: KeyProbeVerdict
    readonly reason: string | null
  } | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** What one provider-scoped inference call needs, ready for an Inference Adapter. */
export interface InferenceTarget {
  readonly keyId: string
  readonly baseUrl: string
  readonly allowInsecureHttp: boolean
  /** The decrypted Upstream Key; it exists only for the duration of the call. */
  readonly upstreamKey: string
}

export interface ConnectionView {
  readonly id: string
  readonly displayName: string
  readonly baseUrl: string
  readonly allowInsecureHttp: boolean
  readonly enabled: boolean
  readonly archived: boolean
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly keys: readonly KeyView[]
}

export interface ProviderConnectionRegistryOptions {
  readonly database: Database
  readonly cipher: SecretCipher
  readonly keyProbe: UpstreamKeyProbe
  readonly clock?: Clock
}

const DISPLAY_NAME_MAXIMUM = 128
const BASE_URL_MAXIMUM = 2048
const UPSTREAM_KEY_MAXIMUM = 2048

/**
 * What Iroha knows about configuring Provider Connections.
 *
 * The rules that matter live here rather than in the HTTP layer: IDs never
 * change, keys are stored before they are tested, an inconclusive test keeps
 * its reason instead of discarding the secret, secret material is encrypted on
 * the way in and never leaves again, and archive stands between a connection
 * and its purge.
 */
export class ProviderConnectionRegistry {
  readonly #database: Database
  readonly #cipher: SecretCipher
  readonly #probe: UpstreamKeyProbe
  readonly #clock: Clock

  constructor(options: ProviderConnectionRegistryOptions) {
    this.#database = options.database
    this.#cipher = options.cipher
    this.#probe = options.keyProbe
    this.#clock = options.clock ?? systemClock
  }

  /** Every connection, archived ones included, most recently created first. */
  async list(): Promise<readonly ConnectionView[]> {
    const connections = await this.#database.providers.listConnections()

    return await Promise.all(
      connections.map(async (connection) => ({
        ...summaryOf(connection),
        keys: await this.#keysOf(connection.id),
      })),
    )
  }

  async get(id: string): Promise<ConnectionView | null> {
    const connection = await this.#database.providers.getConnection(id)
    if (connection === null) return null

    return { ...summaryOf(connection), keys: await this.#keysOf(connection.id) }
  }

  /**
   * Creates a connection with one Upstream Key. The key is stored encrypted
   * and Unverified first, then tested; a usable test activates it, anything
   * else keeps the key and records why.
   */
  async create(input: {
    displayName: unknown
    baseUrl: unknown
    upstreamKey: unknown
    allowInsecureHttp?: unknown
  }): Promise<ProviderResult<ConnectionView>> {
    const allowInsecureHttp = input.allowInsecureHttp === true

    const problems = [
      ...displayNameProblems(input.displayName),
      ...baseUrlProblems(input.baseUrl, allowInsecureHttp),
      ...upstreamKeyProblems(input.upstreamKey),
    ]
    if (problems.length > 0) return failed({ code: 'validation_failed', problems })

    const displayName = (input.displayName as string).trim()
    const baseUrl = (input.baseUrl as string).trim()
    const upstreamKey = (input.upstreamKey as string).trim()

    const encryptedKey = await this.#cipher.encrypt(upstreamKey)
    const at = this.#clock.now()
    const connectionId = newId('pc')

    await this.#database.transaction(async (repositories) => {
      await repositories.providers.insertConnection({
        id: connectionId,
        displayName,
        baseUrl,
        allowInsecureHttp,
        enabled: true,
        archivedAt: null,
        templateId: null,
        capabilities: defaultCapabilities(),
        createdAt: at,
        updatedAt: at,
      })
      await repositories.providers.insertKey({
        id: newId('uk'),
        connectionId,
        encryptedKey,
        health: 'unverified',
        lastProbeAt: null,
        lastProbeVerdict: null,
        lastProbeReason: null,
        createdAt: at,
        updatedAt: at,
      })
      await repositories.audit.record({
        action: 'connection.created',
        outcome: 'success',
        detail: { connectionId, displayName },
        at,
      })
    })

    await this.#probeConnectionKeys(connectionId)

    const created = await this.get(connectionId)
    return created === null ? failed({ code: 'connection_not_found' }) : { ok: true, value: created }
  }

  /** Edits the editable fields of a live connection. The ID never moves. */
  async update(
    id: string,
    patch: {
      displayName?: unknown
      baseUrl?: unknown
      allowInsecureHttp?: unknown
      enabled?: unknown
    },
  ): Promise<ProviderResult<ConnectionView>> {
    const connection = await this.#database.providers.getConnection(id)
    if (connection === null) return failed({ code: 'connection_not_found' })
    if (connection.archivedAt !== null) return failed({ code: 'connection_archived' })

    const changes: {
      displayName?: string
      baseUrl?: string
      allowInsecureHttp?: boolean
      enabled?: boolean
    } = {}

    if (patch.displayName !== undefined) {
      const problems = displayNameProblems(patch.displayName)
      if (problems.length > 0) return failed({ code: 'validation_failed', problems })
      changes.displayName = (patch.displayName as string).trim()
    }

    if (patch.allowInsecureHttp !== undefined) {
      changes.allowInsecureHttp = patch.allowInsecureHttp === true
    }

    if (patch.baseUrl !== undefined) {
      const problems = baseUrlProblems(
        patch.baseUrl,
        changes.allowInsecureHttp ?? connection.allowInsecureHttp,
      )
      if (problems.length > 0) return failed({ code: 'validation_failed', problems })
      changes.baseUrl = (patch.baseUrl as string).trim()
    }

    if (patch.enabled !== undefined) {
      changes.enabled = patch.enabled === true
    }

    if (changes.baseUrl === undefined && changes.allowInsecureHttp !== undefined) {
      // The flag changed under an unchanged URL: an https URL ignores the
      // flag, but an http URL must not lose its exception.
      if (new URL(connection.baseUrl).protocol === 'http:' && changes.allowInsecureHttp === false) {
        return failed({
          code: 'validation_failed',
          problems: [
            {
              field: 'allowInsecureHttp',
              message: 'cannot be withdrawn while the base URL still uses plain HTTP',
            },
          ],
        })
      }
    }

    if (Object.keys(changes).length === 0) {
      return { ok: true, value: await this.#viewOf(connection.id) }
    }

    const at = this.#clock.now()
    await this.#database.transaction(async (repositories) => {
      await repositories.providers.updateConnection(id, changes, at)
      await repositories.audit.record({
        action: 'connection.updated',
        outcome: 'success',
        // Field names only: a base URL may carry as much secret as a key.
        detail: { connectionId: id, fields: Object.keys(changes) },
        at,
      })
    })

    return { ok: true, value: await this.#viewOf(id) }
  }

  /** Archiving preserves the connection's identity and takes it out of use. */
  async archive(id: string): Promise<ProviderResult<ConnectionView>> {
    const connection = await this.#database.providers.getConnection(id)
    if (connection === null) return failed({ code: 'connection_not_found' })

    if (connection.archivedAt === null) {
      const at = this.#clock.now()
      await this.#database.transaction(async (repositories) => {
        await repositories.providers.updateConnection(id, { enabled: false, archivedAt: at }, at)
        await repositories.audit.record({
          action: 'connection.archived',
          outcome: 'success',
          detail: { connectionId: id },
          at,
        })
      })
    }

    return { ok: true, value: await this.#viewOf(id) }
  }

  /**
   * Copies a connection under a brand-new identity. Keys are decrypted only
   * long enough to be re-encrypted, start Unverified again, and are tested
   * like the originals.
   */
  async duplicate(id: string): Promise<ProviderResult<ConnectionView>> {
    const source = await this.#database.providers.getConnection(id)
    if (source === null) return failed({ code: 'connection_not_found' })

    const sourceKeys = await this.#database.providers.listKeys(id)
    const at = this.#clock.now()
    const connectionId = newId('pc')

    const material: { keyId: string; plaintext: string }[] = []
    try {
      for (const key of sourceKeys) {
        material.push({ keyId: newId('uk'), plaintext: await this.#cipher.decrypt(key.encryptedKey) })
      }
    } catch (cause) {
      if (cause instanceof SecretCipherError) return failed({ code: 'stored_key_unreadable' })
      throw cause
    }

    await this.#database.transaction(async (repositories) => {
      await repositories.providers.insertConnection({
        id: connectionId,
        displayName: copiedName(source.displayName),
        baseUrl: source.baseUrl,
        allowInsecureHttp: source.allowInsecureHttp,
        enabled: true,
        archivedAt: null,
        templateId: source.templateId,
        capabilities: source.capabilities,
        createdAt: at,
        updatedAt: at,
      })

      for (const copied of material) {
        await repositories.providers.insertKey({
          id: copied.keyId,
          connectionId,
          encryptedKey: await this.#cipher.encrypt(copied.plaintext),
          health: 'unverified',
          lastProbeAt: null,
          lastProbeVerdict: null,
          lastProbeReason: null,
          createdAt: at,
          updatedAt: at,
        })
      }

      await repositories.audit.record({
        action: 'connection.duplicated',
        outcome: 'success',
        detail: { connectionId, sourceId: id },
        at,
      })
    })

    await this.#probeConnectionKeys(connectionId)

    return { ok: true, value: await this.#viewOf(connectionId) }
  }

  /**
   * Removes a connection and its keys permanently. Nothing is restorable, so
   * deletion is archive-first: only a connection already taken out of active
   * use can be purged.
   */
  async purge(id: string): Promise<ProviderResult<boolean>> {
    const connection = await this.#database.providers.getConnection(id)
    if (connection === null) return failed({ code: 'connection_not_found' })
    if (connection.archivedAt === null) return failed({ code: 'not_archived' })

    const at = this.#clock.now()
    await this.#database.transaction(async (repositories) => {
      await repositories.providers.deleteKeysForConnection(id)
      await repositories.providers.deleteConnection(id)
      await repositories.audit.record({
        action: 'connection.purged',
        outcome: 'success',
        detail: { connectionId: id, displayName: connection.displayName },
        at,
      })
    })

    return { ok: true, value: true }
  }

  /** Runs the key test on demand and records what it learned. */
  async testKey(connectionId: string, keyId: string): Promise<ProviderResult<ConnectionView>> {
    const located = await this.#locateKey(connectionId, keyId)
    if (!located.ok) return located

    const { connection, key } = located.value
    const probe = await this.#runProbe(connection.baseUrl, key.encryptedKey)
    if (!probe.readable) return failed({ code: 'stored_key_unreadable' })

    const at = this.#clock.now()
    // A disabled key stays disabled: a test informs, only activation revives.
    // An unverified key that proves itself usable is activated on the spot.
    const activates = probe.verdict === 'usable' && key.health === 'unverified'
    await this.#database.providers.updateKey(keyId, probedPatch(probe, at, activates), at)
    return { ok: true, value: await this.#viewOf(connectionId) }
  }

  /** The Owner's explicit say-so that an untested or disabled key may be used. */
  async activateKey(connectionId: string, keyId: string): Promise<ProviderResult<ConnectionView>> {
    const located = await this.#locateKey(connectionId, keyId)
    if (!located.ok) return located

    if (located.value.key.health !== 'active') {
      const at = this.#clock.now()
      await this.#database.transaction(async (repositories) => {
        await repositories.providers.updateKey(keyId, { health: 'active' }, at)
        await repositories.audit.record({
          action: 'key.activated',
          outcome: 'success',
          detail: { connectionId, keyId },
          at,
        })
      })
    }

    return { ok: true, value: await this.#viewOf(connectionId) }
  }

  async disableKey(connectionId: string, keyId: string): Promise<ProviderResult<ConnectionView>> {
    const located = await this.#locateKey(connectionId, keyId)
    if (!located.ok) return located

    if (located.value.key.health !== 'disabled') {
      const at = this.#clock.now()
      await this.#database.transaction(async (repositories) => {
        await repositories.providers.updateKey(keyId, { health: 'disabled' }, at)
        await repositories.audit.record({
          action: 'key.disabled',
          outcome: 'success',
          detail: { connectionId, keyId },
          at,
        })
      })
    }

    return { ok: true, value: await this.#viewOf(connectionId) }
  }

  /**
   * Resolves which Upstream Key serves one provider-scoped inference call.
   * Only an Active key is eligible; the winner's material is decrypted just
   * long enough for the request, the connection must be enabled and
   * unarchived, and an undisabled connection with no eligible key is reported
   * rather than guessed at.
   */
  async resolveInference(connectionId: string): Promise<ProviderResult<InferenceTarget>> {
    const connection = await this.#database.providers.getConnection(connectionId)
    if (connection === null) return failed({ code: 'connection_not_found' })
    if (connection.archivedAt !== null) return failed({ code: 'connection_archived' })
    if (!connection.enabled) return failed({ code: 'connection_disabled' })

    const key =
      (await this.#database.providers.listKeys(connectionId)).find(
        (candidate) => candidate.health === 'active',
      ) ?? null
    if (key === null) return failed({ code: 'no_eligible_key' })

    let upstreamKey: string
    try {
      upstreamKey = await this.#cipher.decrypt(key.encryptedKey)
    } catch (cause) {
      if (cause instanceof SecretCipherError) return failed({ code: 'stored_key_unreadable' })
      throw cause
    }

    return {
      ok: true,
      value: {
        keyId: key.id,
        baseUrl: connection.baseUrl,
        allowInsecureHttp: connection.allowInsecureHttp,
        upstreamKey,
      },
    }
  }

  async #locateKey(
    connectionId: string,
    keyId: string,
  ): Promise<
    ProviderResult<{ readonly connection: ProviderConnectionRecord; readonly key: UpstreamKeyRecord }>
  > {
    const connection = await this.#database.providers.getConnection(connectionId)
    if (connection === null) return failed({ code: 'connection_not_found' })
    if (connection.archivedAt !== null) return failed({ code: 'connection_archived' })

    const key = await this.#database.providers.getKey(keyId)
    if (key === null || key.connectionId !== connectionId) return failed({ code: 'key_not_found' })

    return { ok: true, value: { connection, key } }
  }

  /** Tests every unverified key of one connection the way creation and duplication do. */
  async #probeConnectionKeys(connectionId: string): Promise<void> {
    const connection = await this.#database.providers.getConnection(connectionId)
    if (connection === null) return

    for (const key of await this.#database.providers.listKeys(connectionId)) {
      if (key.health !== 'unverified') continue

      const probe = await this.#runProbe(connection.baseUrl, key.encryptedKey)
      if (!probe.readable) continue

      const at = this.#clock.now()
      await this.#database.providers.updateKey(
        key.id,
        probedPatch(probe, at, probe.verdict === 'usable'),
        at,
      )
    }
  }

  async #runProbe(
    baseUrl: string,
    encryptedKey: string,
  ): Promise<ProbeRun> {
    let plaintext: string
    try {
      plaintext = await this.#cipher.decrypt(encryptedKey)
    } catch (cause) {
      if (cause instanceof SecretCipherError) return { readable: false }
      throw cause
    }

    try {
      const { verdict, reason } = await this.#probe.test({ baseUrl, upstreamKey: plaintext })
      return { readable: true, verdict, reason }
    } catch {
      return { readable: true, verdict: 'inconclusive', reason: 'the key test did not complete' }
    }
  }

  async #keysOf(connectionId: string): Promise<readonly KeyView[]> {
    const keys = await this.#database.providers.listKeys(connectionId)

    return keys.map((key) => ({
      id: key.id,
      health: key.health,
      lastProbe:
        key.lastProbeAt === null || key.lastProbeVerdict === null
          ? null
          : { at: key.lastProbeAt, verdict: key.lastProbeVerdict, reason: key.lastProbeReason },
      createdAt: key.createdAt,
      updatedAt: key.updatedAt,
    }))
  }

  async #viewOf(id: string): Promise<ConnectionView> {
    const view = await this.get(id)
    if (view === null) throw new Error(`Provider connection ${id} vanished mid-operation`)
    return view
  }
}

/** One attempt to probe a stored key. Either it ran or the material was unreadable. */
type ProbeRun =
  | { readonly readable: false }
  | { readonly readable: true; readonly verdict: KeyProbeVerdict; readonly reason: string | null }

/** The stored result of one probe; optionally activating an unverified key. */
function probedPatch(probe: { readonly verdict: KeyProbeVerdict; readonly reason: string | null }, at: Date, activates: boolean): UpstreamKeyPatch {
  return activates
    ? {
        health: 'active',
        lastProbeAt: at,
        lastProbeVerdict: probe.verdict,
        lastProbeReason: probe.reason,
      }
    : {
        lastProbeAt: at,
        lastProbeVerdict: probe.verdict,
        lastProbeReason: probe.reason,
      }
}

function summaryOf(connection: {
  id: string
  displayName: string
  baseUrl: string
  allowInsecureHttp: boolean
  enabled: boolean
  archivedAt: Date | null
  createdAt: Date
  updatedAt: Date
}): Omit<ConnectionView, 'keys'> {
  return {
    id: connection.id,
    displayName: connection.displayName,
    baseUrl: connection.baseUrl,
    allowInsecureHttp: connection.allowInsecureHttp,
    enabled: connection.enabled,
    archived: connection.archivedAt !== null,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  }
}

function displayNameProblems(input: unknown): readonly FieldProblem[] {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return [{ field: 'displayName', message: 'is required' }]
  }

  if (input.trim().length > DISPLAY_NAME_MAXIMUM) {
    return [{ field: 'displayName', message: `must be at most ${DISPLAY_NAME_MAXIMUM} characters` }]
  }

  return []
}

function baseUrlProblems(input: unknown, allowInsecureHttp: boolean): readonly FieldProblem[] {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return [{ field: 'baseUrl', message: 'is required' }]
  }

  const raw = input.trim()
  if (raw.length > BASE_URL_MAXIMUM) {
    return [{ field: 'baseUrl', message: `must be at most ${BASE_URL_MAXIMUM} characters` }]
  }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return [{ field: 'baseUrl', message: 'is not a parseable URL' }]
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return [{ field: 'baseUrl', message: 'must use https:// or, explicitly, http://' }]
  }

  if (url.protocol === 'http:' && !allowInsecureHttp) {
    return [
      {
        field: 'baseUrl',
        message: 'uses plain HTTP, which sends the Upstream Key unencrypted; allow it explicitly',
      },
    ]
  }

  if (url.username !== '' || url.password !== '') {
    return [{ field: 'baseUrl', message: 'must not embed a username or password' }]
  }

  return []
}

function upstreamKeyProblems(input: unknown): readonly FieldProblem[] {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return [{ field: 'upstreamKey', message: 'is required' }]
  }

  if (input.trim().length > UPSTREAM_KEY_MAXIMUM) {
    return [{ field: 'upstreamKey', message: `must be at most ${UPSTREAM_KEY_MAXIMUM} characters` }]
  }

  return []
}

/** A duplicate gets a recognisably related name without colliding silently. */
function copiedName(displayName: string): string {
  const suffix = ' (copy)'
  const stem = displayName.slice(0, DISPLAY_NAME_MAXIMUM - suffix.length)
  return `${stem}${suffix}`
}

/**
 * The honest default capability claim for a connection created without a
 * Provider Template: unknown-off, never assumed. Template and catalog work can
 * enrich these claims later without Iroha silently assuming a Provider behaves
 * like a different one.
 */
function defaultCapabilities(): ConnectionCapabilities {
  return {
    chat: false,
    streaming: false,
    tools: false,
    structuredOutput: false,
    responses: false,
  }
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('base64url')}`
}

function failed(failure: ProviderFailure): ProviderResult<never> {
  return { ok: false, failure }
}
