/**
 * The Usage Adapter surface: typed adapters that read authoritative Provider
 * entitlement when a documented API exists, the reactive-only generic
 * adapter, the service that polls them and persists their outcome, and the
 * mock adapters tests use to exercise the contract.
 */
export { createGenericUsageAdapter } from './generic-adapter.ts'
export {
  createMinimaxUsageAdapter,
  minimaxCapacityEvidenceOf,
  type MinimaxUsageAdapterOptions,
} from './minimax-usage-adapter.ts'
export {
  createZaiUsageAdapter,
  zaiCapacityEvidenceOf,
  zaiUsageReadings,
  type ZaiUsageAdapterOptions,
} from './zai-usage-adapter.ts'
export {
  createMockCreditUsageAdapter,
  type MockCreditUsageAdapter,
  type MockCreditUsageAdapterOptions,
} from './mock-credit-adapter.ts'
export {
  createMockPlanUsageAdapter,
  type MockPlanUsageAdapter,
  type MockPlanUsageAdapterOptions,
} from './mock-plan-adapter.ts'
export {
  UsageService,
  type UsageServiceFailure,
  type UsageServiceOptions,
  type UsageServiceResult,
  type UsageView,
} from './usage-service.ts'
export type {
  UsageAdapter,
  UsageAdapterRequest,
  UsageCapacityScope,
  UsageFailure,
  UsagePollResult,
  UsageReading,
  UsageRecoveryEvidence,
  UsageVisibility,
} from './adapter.ts'
export { recoveryEvidenceOf } from './adapter.ts'
