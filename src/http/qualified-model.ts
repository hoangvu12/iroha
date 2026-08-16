import type { GatewayKeyRegistry } from '../keys/index.ts'
import type { Database } from '../persistence/index.ts'

export type QualifiedModelFailure =
  | 'gateway_key_invalid'
  | 'invalid_model_id'
  | 'provider_not_allowed'
  | 'model_not_allowed'

export type QualifiedModelResult =
  | { readonly ok: true; readonly providerId: string; readonly modelId: string; readonly gatewayKeyId: string; readonly gatewayKeyName: string }
  | { readonly ok: false; readonly code: QualifiedModelFailure }

/** Splits only the first slash; the exact remaining upstream model ID is opaque. */
export function parseQualifiedModelId(input: unknown):
  | { readonly ok: true; readonly providerId: string; readonly modelId: string }
  | { readonly ok: false; readonly code: 'invalid_model_id' } {
  if (typeof input !== 'string') return { ok: false, code: 'invalid_model_id' }
  const separator = input.indexOf('/')
  if (separator <= 0 || separator === input.length - 1) return { ok: false, code: 'invalid_model_id' }
  return { ok: true, providerId: input.slice(0, separator), modelId: input.slice(separator + 1) }
}

export async function authorizeQualifiedModel(options: {
  readonly input: unknown
  readonly token: string | null
  readonly gatewayKeys: GatewayKeyRegistry
  readonly database: Database
}): Promise<QualifiedModelResult> {
  const parsed = parseQualifiedModelId(options.input)
  if (!parsed.ok) return parsed

  const providerAuthorization = await options.gatewayKeys.authorizeProvider(parsed.providerId, options.token)
  if (!providerAuthorization.ok) {
    return { ok: false, code: providerAuthorization.code === 'gateway_key_invalid' ? 'gateway_key_invalid' : 'provider_not_allowed' }
  }
  const provider = await options.database.providers.getProvider(parsed.providerId)
  if (provider === null || provider.archivedAt !== null || !provider.enabled) {
    return { ok: false, code: 'provider_not_allowed' }
  }
  const modelAuthorization = await options.gatewayKeys.authorizeInference(parsed.providerId, parsed.modelId, options.token)
  if (!modelAuthorization.ok) {
    return { ok: false, code: modelAuthorization.code === 'model_not_allowed' ? 'model_not_allowed' : 'provider_not_allowed' }
  }
  if (await options.database.modelCatalog.isExcluded(parsed.providerId, parsed.modelId)) {
    return { ok: false, code: 'model_not_allowed' }
  }
  return {
    ok: true,
    providerId: parsed.providerId,
    modelId: parsed.modelId,
    gatewayKeyId: modelAuthorization.keyId,
    gatewayKeyName: modelAuthorization.keyName,
  }
}
