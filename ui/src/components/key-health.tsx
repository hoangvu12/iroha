import type { KeyView } from '@/lib/providers'
import { StatusBadge, type StatusTone } from '@/components/status-badge'

/** Maps a key health state to the tone used by status badges. */
export function healthTone(health: KeyView['health']): StatusTone {
  switch (health) {
    case 'active':
      return 'healthy'
    case 'unverified':
    case 'cooling_down':
      return 'warning'
    case 'invalid_authentication':
    case 'exhausted':
      return 'danger'
    case 'disabled':
      return 'neutral'
  }
}

export const HEALTH_LABELS: Record<KeyView['health'], string> = {
  unverified: 'Unverified',
  active: 'Active',
  cooling_down: 'Cooling Down',
  invalid_authentication: 'Invalid Authentication',
  exhausted: 'Exhausted',
  disabled: 'Disabled',
}

export const HEALTH_ORDER: readonly KeyView['health'][] = [
  'active',
  'unverified',
  'cooling_down',
  'invalid_authentication',
  'exhausted',
  'disabled',
]

/** Returns true when a key needs attention right now. */
export function keyNeedsAttention(key: KeyView): boolean {
  return (
    key.health === 'cooling_down' ||
    key.health === 'invalid_authentication' ||
    key.health === 'exhausted'
  )
}

/** Returns true when a key has not been tested since being saved. */
export function keyIsUntested(key: KeyView): boolean {
  return key.health === 'unverified' && key.lastProbe === null
}

/** Status badge for a key, paired with a colour and a word. */
export function KeyHealthBadge({ health }: { readonly health: KeyView['health'] }) {
  return <StatusBadge tone={healthTone(health)} label={HEALTH_LABELS[health]} />
}