import type { ProviderRecord } from '../../src/persistence/index.ts'

/** A known-stable Provider row for tests that need one without setting defaults. */
export const PROVIDER_DEFAULT_BASE_URL = 'https://api.example.com/v1'

/** Default `now` timestamp used to populate `createdAt`/`updatedAt` on test Providers. */
export const PROVIDER_DEFAULT_CREATED_AT = new Date('2026-01-01T00:00:00.000Z')

/**
 * Builds a {@link ProviderRecord} with sensible defaults. Tests that need a
 * Provider row call this rather than spelling every field out, so a future
 * schema addition only changes here.
 */
export function providerRecord(
  id: string,
  overrides: Partial<ProviderRecord> = {},
): ProviderRecord {
  return {
    id,
    displayName: 'Example',
    baseUrl: PROVIDER_DEFAULT_BASE_URL,
    allowInsecureHttp: false,
    enabled: true,
    retryMaxAttempts: 3,
    retryAmbiguousNetwork: false,
    archivedAt: null,
    templateId: null,
    capabilities: {
      chat: false,
      streaming: false,
      tools: false,
      structuredOutput: false,
      responses: false,
    },
    authHeader: 'authorization',
    authPrefix: 'Bearer ',
    staticHeadersEncrypted: '[]',
    redirectAllowSameOrigin: false,
    connectionTimeoutMs: 10_000,
    firstByteTimeoutMs: 20_000,
    nonStreamingTotalTimeoutMs: 120_000,
    streamingIdleTimeoutMs: 30_000,
    totalRetryTimeoutMs: 30_000,
    idempotencyHeader: 'Idempotency-Key',
    createdAt: PROVIDER_DEFAULT_CREATED_AT,
    updatedAt: PROVIDER_DEFAULT_CREATED_AT,
    ...overrides,
  }
}
