import type { GatewayKeyRegistry } from '../keys/index.ts'
import type { Database } from '../persistence/index.ts'
import { isProviderHandle, type ProviderRegistry } from '../providers/index.ts'

export type QualifiedModelFailure =
  | 'gateway_key_invalid'
  | 'invalid_model_id'
  | 'invalid_provider_handle'
  | 'provider_not_allowed'
  | 'model_not_allowed'

export type QualifiedModelResult =
  | { readonly ok: true; readonly providerId: string; readonly providerHandle: string; readonly modelId: string; readonly gatewayKeyId: string; readonly gatewayKeyName: string }
  | { readonly ok: false; readonly code: QualifiedModelFailure }

/** Splits only the first slash; the exact remaining upstream model ID is opaque. */
export function parseQualifiedModelId(input: unknown):
  | { readonly ok: true; readonly providerHandle: string; readonly modelId: string }
  | { readonly ok: false; readonly code: 'invalid_model_id' } {
  if (typeof input !== 'string') return { ok: false, code: 'invalid_model_id' }
  const separator = input.indexOf('/')
  if (separator <= 0 || separator === input.length - 1) return { ok: false, code: 'invalid_model_id' }
  const providerHandle = input.slice(0, separator)
  if (!isProviderHandle(providerHandle)) {
    return { ok: false, code: 'invalid_model_id' }
  }
  return { ok: true, providerHandle, modelId: input.slice(separator + 1) }
}

export async function authorizeQualifiedModel(options: {
  readonly input: unknown
  readonly token: string | null
  readonly gatewayKeys: GatewayKeyRegistry
  readonly database: Database
  readonly providers: ProviderRegistry
}): Promise<QualifiedModelResult> {
  const parsed = parseQualifiedModelId(options.input)
  if (!parsed.ok) return parsed

  const authentication = await options.gatewayKeys.discover(options.token ?? '')
  if (!authentication.ok) return { ok: false, code: 'gateway_key_invalid' }

  const provider = await options.providers.resolveHandle(parsed.providerHandle)
  if (!provider.ok) return provider
  const providerAuthorization = await options.gatewayKeys.authorizeProvider(provider.providerId, options.token)
  if (!providerAuthorization.ok) {
    return { ok: false, code: providerAuthorization.code === 'gateway_key_invalid' ? 'gateway_key_invalid' : 'provider_not_allowed' }
  }
  const modelAuthorization = await options.gatewayKeys.authorizeInference(provider.providerId, parsed.modelId, options.token)
  if (!modelAuthorization.ok) {
    return { ok: false, code: modelAuthorization.code === 'model_not_allowed' ? 'model_not_allowed' : 'provider_not_allowed' }
  }
  if (await options.database.modelCatalog.isExcluded(provider.providerId, parsed.modelId)) {
    return { ok: false, code: 'model_not_allowed' }
  }
  return {
    ok: true,
    providerId: provider.providerId,
    providerHandle: provider.providerHandle,
    modelId: parsed.modelId,
    gatewayKeyId: modelAuthorization.keyId,
    gatewayKeyName: modelAuthorization.keyName,
  }
}
