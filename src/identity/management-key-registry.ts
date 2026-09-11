import { randomBytes } from 'node:crypto'
import type { Database } from '../persistence/index.ts'
import { hashSecret, randomSecret, secretsMatch } from './secrets.ts'

const STORE_KEY = 'identity.management_keys'

export type ManagementKeyScope = 'admin:read' | 'admin:write' | 'upstream-keys:reveal'
export const MANAGEMENT_KEY_SCOPES: readonly ManagementKeyScope[] = [
  'admin:read',
  'admin:write',
  'upstream-keys:reveal',
]

interface StoredManagementKey {
  id: string
  name: string
  secretHash: string
  scopes: ManagementKeyScope[]
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
}

export interface ManagementKeyView {
  readonly id: string
  readonly name: string
  readonly scopes: readonly ManagementKeyScope[]
  readonly createdAt: Date
  readonly lastUsedAt: Date | null
  readonly expiresAt: Date | null
  readonly revokedAt: Date | null
}

export interface AuthenticatedManagementKey {
  readonly key: ManagementKeyView
}

export class ManagementKeyRegistry {
  constructor(private readonly database: Database, private readonly clock: () => Date = () => new Date()) {}

  async list(): Promise<readonly ManagementKeyView[]> {
    return (await this.#read()).map(toView).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  }

  async create(input: { name: unknown; scopes?: unknown; expiresAt?: unknown }): Promise<
    { ok: true; value: { key: ManagementKeyView; secret: string } } |
    { ok: false; problems: readonly { field: string; message: string }[] }
  > {
    const problems = validateInput(input)
    if (problems.length > 0) return { ok: false, problems }
    const now = this.clock()
    const id = `mk_${randomBytes(12).toString('base64url')}`
    const secretPart = randomSecret()
    const secret = `${id}.${secretPart}`
    const record: StoredManagementKey = {
      id,
      name: (input.name as string).trim(),
      secretHash: hashSecret(secretPart),
      scopes: (input.scopes as ManagementKeyScope[] | undefined) ?? [...MANAGEMENT_KEY_SCOPES],
      createdAt: now.toISOString(),
      lastUsedAt: null,
      expiresAt: input.expiresAt == null ? null : new Date(input.expiresAt as string).toISOString(),
      revokedAt: null,
    }
    await this.database.transaction(async ({ settings, audit }) => {
      const current = decode((await settings.get(STORE_KEY))?.value)
      await settings.put(STORE_KEY, [...current, record])
      await audit.record({ action: 'management_key.created', outcome: 'success', detail: { keyId: id, name: record.name, scopes: record.scopes }, at: now })
    })
    return { ok: true, value: { key: toView(record), secret } }
  }

  async authenticate(token: string | null, required: ManagementKeyScope): Promise<AuthenticatedManagementKey | null> {
    if (token === null) return null
    const separator = token.indexOf('.')
    if (separator < 1) return null
    const id = token.slice(0, separator)
    const secret = token.slice(separator + 1)
    if (!id.startsWith('mk_') || secret.length === 0) return null
    const records = await this.#read()
    const record = records.find((candidate) => candidate.id === id)
    const now = this.clock()
    if (!record || record.revokedAt !== null || (record.expiresAt !== null && new Date(record.expiresAt) <= now)) return null
    if (!record.scopes.includes(required) || !secretsMatch(record.secretHash, hashSecret(secret))) return null
    record.lastUsedAt = now.toISOString()
    await this.database.settings.put(STORE_KEY, records)
    return { key: toView(record) }
  }

  async revoke(id: string): Promise<ManagementKeyView | null> {
    const now = this.clock()
    let result: StoredManagementKey | null = null
    await this.database.transaction(async ({ settings, audit }) => {
      const records = decode((await settings.get(STORE_KEY))?.value)
      const record = records.find((candidate) => candidate.id === id)
      if (!record) return
      record.revokedAt ??= now.toISOString()
      await settings.put(STORE_KEY, records)
      await audit.record({ action: 'management_key.revoked', outcome: 'success', detail: { keyId: id }, at: now })
      result = record
    })
    return result === null ? null : toView(result)
  }

  async delete(id: string): Promise<'deleted' | 'active' | 'not_found'> {
    let outcome: 'deleted' | 'active' | 'not_found' = 'not_found'
    await this.database.transaction(async ({ settings, audit }) => {
      const records = decode((await settings.get(STORE_KEY))?.value)
      const index = records.findIndex((candidate) => candidate.id === id)
      if (index < 0) return
      if (records[index]!.revokedAt === null) { outcome = 'active'; return }
      records.splice(index, 1)
      await settings.put(STORE_KEY, records)
      await audit.record({ action: 'management_key.deleted', outcome: 'success', detail: { keyId: id }, at: this.clock() })
      outcome = 'deleted'
    })
    return outcome
  }

  async #read(): Promise<StoredManagementKey[]> {
    return decode((await this.database.settings.get(STORE_KEY))?.value)
  }
}

function validateInput(input: { name: unknown; scopes?: unknown; expiresAt?: unknown }) {
  const problems: { field: string; message: string }[] = []
  if (typeof input.name !== 'string' || input.name.trim().length < 1 || input.name.trim().length > 100) problems.push({ field: 'name', message: 'Name must contain 1 to 100 characters.' })
  if (input.scopes !== undefined && (!Array.isArray(input.scopes) || input.scopes.length < 1 || input.scopes.some((scope) => !MANAGEMENT_KEY_SCOPES.includes(scope)))) problems.push({ field: 'scopes', message: 'Scopes must be a non-empty array of supported Management Key scopes.' })
  if (input.expiresAt !== undefined && input.expiresAt !== null && (typeof input.expiresAt !== 'string' || !Number.isFinite(Date.parse(input.expiresAt)))) problems.push({ field: 'expiresAt', message: 'Expiry must be an ISO-8601 timestamp or null.' })
  return problems
}

function decode(value: unknown): StoredManagementKey[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is StoredManagementKey => typeof item === 'object' && item !== null && typeof (item as StoredManagementKey).id === 'string')
}

function toView(record: StoredManagementKey): ManagementKeyView {
  return { id: record.id, name: record.name, scopes: record.scopes, createdAt: new Date(record.createdAt), lastUsedAt: record.lastUsedAt ? new Date(record.lastUsedAt) : null, expiresAt: record.expiresAt ? new Date(record.expiresAt) : null, revokedAt: record.revokedAt ? new Date(record.revokedAt) : null }
}
