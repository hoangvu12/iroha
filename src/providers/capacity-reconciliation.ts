import type { UpstreamKeyHealth } from '../persistence/repository.ts'
import type {
  CapacityEvidence,
  CapacityReason,
  CapacityScope,
  CredentialEvidence,
} from './provider-evidence.ts'

const CREDIT_RECHECK_MS = 15 * 60_000
const SUBSCRIPTION_SAFETY_RECHECK_MS = 5 * 60_000
const SUBSCRIPTION_BOUNDARY_GRACE_MS = 5_000

export interface DurableCapacityState {
  readonly health: UpstreamKeyHealth
  readonly reason: string | null
  readonly retryAfterAt: Date | null
  readonly scope: CapacityScope['kind']
  readonly scopeId: string | null
  readonly model: string | null
}

export interface CapacityReconciliationInput {
  readonly ownerEnabled: boolean
  readonly keyId: string
  readonly accountId: string | null
  /** Exact model whose Routing Eligibility is being derived, when applicable. */
  readonly model: string | null
  readonly existing: DurableCapacityState
  readonly credentialEvidence: CredentialEvidence | null
  readonly capacityEvidence: readonly CapacityEvidence[]
  readonly now: Date
  /** Returns a non-negative synchronization-spreading delay for a boundary. */
  readonly jitterMs?: (evidence: CapacityEvidence) => number
}

export interface CapacityReconciliationResult extends DurableCapacityState {
  readonly routingEligible: boolean
  readonly nextCheckAt: Date | null
  readonly appliedEvidence: CapacityEvidence | null
  readonly evidenceFresh: boolean
}

/**
 * Derives durable Key Health and request-model Routing Eligibility from
 * Provider-normalized evidence. Provider-specific status and entitlement
 * meanings must be resolved before calling this interface.
 */
export function reconcileCapacity(input: CapacityReconciliationInput): CapacityReconciliationResult {
  if (!input.ownerEnabled) {
    return resultFrom(input, 'disabled', 'disabled by Owner', null, null, false)
  }

  if (input.credentialEvidence?.verdict === 'rejected') {
    return resultFrom(
      input,
      'invalid_authentication',
      input.credentialEvidence.reason ?? 'Provider rejected the Upstream Key',
      null,
      null,
      false,
    )
  }

  const applicable = input.capacityEvidence.filter((item) => scopeApplies(item.scope, input))
  const freshAuthoritative = applicable.filter((item) =>
    item.authority === 'authoritative' && item.freshUntil.getTime() >= input.now.getTime()
  )
  const exhausted = freshAuthoritative.find(isExhausted)

  if (exhausted !== undefined) {
    const nextCheckAt = exhaustedCheckAt(exhausted, input)
    return {
      health: 'exhausted',
      reason: reasonOf(exhausted.reason),
      retryAfterAt: nextCheckAt,
      scope: exhausted.scope.kind,
      scopeId: scopeIdOf(exhausted.scope),
      model: exhausted.scope.kind === 'connection_model' ? exhausted.scope.model : null,
      routingEligible: false,
      nextCheckAt,
      appliedEvidence: exhausted,
      evidenceFresh: true,
    }
  }

  // Invalid authentication is deliberately sticky. Capacity says nothing
  // about whether the Provider will accept the secret.
  if (input.existing.health === 'invalid_authentication') {
    return preserve(input, freshAuthoritative.length > 0)
  }

  const limited = freshAuthoritative.find((item) => item.availability === 'temporarily_limited')
  if (limited !== undefined) {
    // A throttle is not positive entitlement and therefore cannot downgrade
    // durable authoritative exhaustion into a temporary state.
    if (input.existing.health === 'exhausted') return preserve(input, true)
    return {
      health: 'cooling_down',
      reason: reasonOf(limited.reason),
      retryAfterAt: limited.recheckAt,
      scope: limited.scope.kind,
      scopeId: scopeIdOf(limited.scope),
      model: limited.scope.kind === 'connection_model' ? limited.scope.model : null,
      routingEligible: false,
      nextCheckAt: limited.recheckAt,
      appliedEvidence: limited,
      evidenceFresh: true,
    }
  }

  const positive = freshAuthoritative.find(isPositive)
  if (positive !== undefined) {
    if (input.existing.health === 'cooling_down'
      && input.existing.scope === 'connection_model'
      && input.existing.model !== null
      && input.model !== input.existing.model) return preserve(input, true)
    return {
      health: 'active',
      reason: reasonOf(positive.reason),
      retryAfterAt: null,
      scope: positive.scope.kind,
      scopeId: scopeIdOf(positive.scope),
      model: positive.scope.kind === 'connection_model' ? positive.scope.model : null,
      routingEligible: true,
      nextCheckAt: positive.recheckAt,
      appliedEvidence: positive,
      evidenceFresh: true,
    }
  }

  // Authentication, inconclusive probes, stale readings, failed refreshes,
  // and unsupported/unknown capacity never erase the last durable decision.
  return preserve(input, false)
}

function isExhausted(evidence: CapacityEvidence): boolean {
  return evidence.availability === 'exhausted' || hasNonPositiveCapacity(evidence)
}

function isPositive(evidence: CapacityEvidence): boolean {
  if (evidence.availability !== 'available') return false
  const values = [evidence.facts.remaining, evidence.facts.remainingPercent]
    .filter((value): value is number => value !== undefined)
  return values.length === 0 || values.every((value) => value > 0)
}

function hasNonPositiveCapacity(evidence: CapacityEvidence): boolean {
  return evidence.facts.remaining !== undefined && evidence.facts.remaining <= 0
    || evidence.facts.remainingPercent !== undefined && evidence.facts.remainingPercent <= 0
}

function exhaustedCheckAt(
  evidence: CapacityEvidence,
  input: CapacityReconciliationInput,
): Date {
  if (evidence.reason === 'credit_exhausted') {
    return new Date(input.now.getTime() + CREDIT_RECHECK_MS)
  }

  const safety = input.now.getTime() + SUBSCRIPTION_SAFETY_RECHECK_MS
  if (evidence.reason !== 'window_exhausted' || evidence.recheckAt === null) return new Date(safety)
  const jitter = Math.max(0, input.jitterMs?.(evidence) ?? 0)
  const boundary = evidence.recheckAt.getTime() + SUBSCRIPTION_BOUNDARY_GRACE_MS + jitter
  return new Date(Math.min(boundary, safety))
}

function scopeApplies(scope: CapacityScope, input: CapacityReconciliationInput): boolean {
  switch (scope.kind) {
    case 'key': return scope.keyId === input.keyId
    case 'account': return input.accountId !== null && scope.accountId === input.accountId
    case 'connection_model': return input.model !== null && scope.model === input.model
    case 'provider': return true
    case 'unknown': return false
  }
}

function scopeIdOf(scope: CapacityScope): string | null {
  switch (scope.kind) {
    case 'key': return scope.keyId
    case 'account': return scope.accountId
    case 'connection_model': return null
    case 'provider':
    case 'unknown': return null
  }
}

function reasonOf(reason: CapacityReason): string {
  return reason.replaceAll('_', ' ')
}

function preserve(input: CapacityReconciliationInput, evidenceFresh: boolean): CapacityReconciliationResult {
  return {
    ...input.existing,
    routingEligible: eligibleFromExisting(input),
    nextCheckAt: input.existing.retryAfterAt,
    appliedEvidence: null,
    evidenceFresh,
  }
}

function eligibleFromExisting(input: CapacityReconciliationInput): boolean {
  if (input.existing.health === 'cooling_down' && input.existing.scope === 'connection_model') {
    return input.existing.model === null || input.model !== input.existing.model
  }
  return input.existing.health === 'active' || input.existing.health === 'unverified'
}

function resultFrom(
  input: CapacityReconciliationInput,
  health: UpstreamKeyHealth,
  reason: string,
  retryAfterAt: Date | null,
  appliedEvidence: CapacityEvidence | null,
  evidenceFresh: boolean,
): CapacityReconciliationResult {
  return {
    health,
    reason,
    retryAfterAt,
    scope: 'key',
    scopeId: input.keyId,
    model: null,
    routingEligible: false,
    nextCheckAt: retryAfterAt,
    appliedEvidence,
    evidenceFresh,
  }
}
