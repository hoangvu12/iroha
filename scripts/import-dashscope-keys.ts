/**
 * Imports DashScope Upstream Keys from a JSON array of `{ url, key }` entries
 * (as produced by the external recheck pass). Keys already present on the
 * Provider — compared by decrypted plaintext — are skipped, so re-running the
 * import is safe and never duplicates a key.
 *
 * Each imported key is stored encrypted and marked Active with the live
 * completion evidence that admitted it. A key whose file `url` differs from the
 * Provider's default base URL gets a per-Key `base_url` override, so mainland
 * (`dashscope.aliyuncs.com`) and international (`dashscope-intl.aliyuncs.com`)
 * keys can live on one Provider.
 *
 * Usage:
 *   bun run scripts/import-dashscope-keys.ts <keys.json>            # dry run
 *   bun run scripts/import-dashscope-keys.ts <keys.json> --apply
 */
import { randomBytes } from 'node:crypto'
import { loadConfiguration } from '../src/config/environment.ts'
import { createSecretCipher, SecretCipherError } from '../src/crypto/index.ts'
import { openDatabase } from '../src/persistence/index.ts'
import type { UpstreamKeyRecord } from '../src/persistence/repository.ts'

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const providerFlag = argv.indexOf('--provider')
const PROVIDER_HANDLE = providerFlag === -1 ? 'dashscope' : (argv[providerFlag + 1] ?? 'dashscope')
const valueIndexes = new Set([providerFlag].filter((i) => i !== -1).map((i) => i + 1))
const inputPath = argv.find((arg, index) => !arg.startsWith('--') && !valueIndexes.has(index))

if (inputPath === undefined) {
  console.error('Usage: bun run scripts/import-dashscope-keys.ts <keys.json> [--apply] [--provider <handle>]')
  process.exit(1)
}

interface Entry {
  readonly url: string
  readonly key: string
}

const raw = (await Bun.file(inputPath).json()) as readonly unknown[]
const entries: Entry[] = []
const seenInFile = new Set<string>()
let malformed = 0
let duplicateInFile = 0

for (const item of raw) {
  const record = item as Record<string, unknown> | null
  const key = typeof record?.key === 'string' ? record.key.trim() : ''
  const url = typeof record?.url === 'string' ? record.url.trim().replace(/\/+$/, '') : ''
  if (key === '' || url === '') {
    malformed += 1
    continue
  }
  if (seenInFile.has(key)) {
    duplicateInFile += 1
    continue
  }
  seenInFile.add(key)
  entries.push({ url, key })
}

console.log(`Read ${raw.length} entr(ies) from ${inputPath}`)
console.log(`  usable: ${entries.length}, malformed: ${malformed}, duplicate-in-file: ${duplicateInFile}`)

const config = loadConfiguration()
const db = openDatabase(config.database)
const cipher = createSecretCipher(config.masterKey)

try {
  const provider = await db.providers.getProviderByHandle(PROVIDER_HANDLE)
  if (provider === null) {
    console.error(`Provider "${PROVIDER_HANDLE}" not found in Iroha.`)
    process.exit(1)
  }
  console.log(`\nProvider: ${provider.displayName} (${provider.id})`)
  console.log(`  default baseUrl: ${provider.baseUrl}`)

  const existingKeys = await db.providers.listKeys(provider.id)
  const existingPlaintexts = new Set<string>()
  let unreadable = 0
  for (const existing of existingKeys) {
    try {
      existingPlaintexts.add(await cipher.decrypt(existing.encryptedKey))
    } catch (cause) {
      if (!(cause instanceof SecretCipherError)) throw cause
      unreadable += 1
    }
  }
  console.log(`  ${existingKeys.length} existing key(s) (${existingPlaintexts.size} readable, ${unreadable} unreadable)`)

  const toInsert: (Entry & { readonly override: string | null })[] = []
  let alreadyPresent = 0
  for (const entry of entries) {
    if (existingPlaintexts.has(entry.key)) {
      alreadyPresent += 1
      continue
    }
    const override = entry.url === provider.baseUrl ? null : entry.url
    toInsert.push({ ...entry, override })
  }

  console.log(`\n${entries.length} file key(s): ${alreadyPresent} already present, ${toInsert.length} to insert`)
  for (const entry of toInsert) {
    const where = entry.override === null ? 'inherits provider base URL' : `override ${entry.override}`
    console.log(`  + ${entry.key.slice(0, 7)}…${entry.key.slice(-4)}  (${where})`)
  }

  if (toInsert.length === 0) {
    console.log('\nNothing to do.')
    process.exit(0)
  }

  if (!APPLY) {
    console.log('\nDry run. Pass --apply to write to Iroha.')
    process.exit(0)
  }

  const at = new Date()
  let added = 0
  for (const entry of toInsert) {
    const keyId = `uk_${randomBytes(16).toString('base64url')}`
    const record: UpstreamKeyRecord = {
      id: keyId,
      providerId: provider.id,
      baseUrl: entry.override,
      accountId: null,
      encryptedKey: await cipher.encrypt(entry.key),
      health: 'active',
      lastProbeAt: at,
      lastProbeVerdict: 'authenticated',
      lastProbeReason: 'import: live chat completion returned HTTP 200',
      healthReason: 'imported: live chat completion succeeded',
      healthChangedAt: at,
      retryAfterAt: null,
      healthScope: 'key',
      healthScopeId: null,
      healthModel: null,
      allowedModels: null,
      deniedModels: null,
      createdAt: at,
      updatedAt: at,
    }
    await db.transaction(async (repositories) => {
      await repositories.providers.insertKey(record)
      await repositories.audit.record({
        action: 'key.created',
        outcome: 'success',
        detail: {
          providerId: provider.id,
          keyId,
          source: 'import-dashscope-keys',
          baseUrl: entry.override ?? '(inherited)',
        },
        at,
      })
    })
    added += 1
  }

  console.log(`\nInserted ${added} key(s).`)
  const finalKeys = await db.providers.listKeys(provider.id)
  console.log(`Total keys on ${provider.handle} now: ${finalKeys.length}`)
} finally {
  await db.close()
}