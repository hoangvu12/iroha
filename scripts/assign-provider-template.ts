/** Assign an existing Provider to a built-in template after validating it. */
import { loadConfiguration } from '../src/config/environment.ts'
import { openDatabase } from '../src/persistence/index.ts'
import { createBuiltInAdapterRegistry } from '../src/providers/adapter-registry.ts'

const [providerId, templateId] = process.argv.slice(2)
if (!providerId || !templateId) throw new Error('Usage: bun run scripts/assign-provider-template.ts <provider-id> <template-id>')
const registry = createBuiltInAdapterRegistry()
if (!registry.providerTemplate(templateId)) throw new Error(`Unknown built-in template: ${templateId}`)
const db = openDatabase(loadConfiguration().database)
try {
  const provider = await db.providers.getProvider(providerId)
  if (!provider) throw new Error(`Provider not found: ${providerId}`)
  const at = new Date()
  await db.transaction(async (repositories) => {
    await repositories.providers.updateProvider(providerId, { templateId } as never, at)
    await repositories.audit.record({
      action: 'provider.template_assigned',
      outcome: 'success',
      detail: { providerId, previousTemplateId: provider.templateId, templateId },
      at,
    })
  })
  console.log(`${providerId}: ${provider.templateId ?? 'none'} -> ${templateId}`)
} finally {
  await db.close()
}
