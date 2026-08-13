import type { KeyView } from '@/lib/providers'
import { healthTone } from '@/components/key-health'

export type ProviderStatus = {
  readonly tone: 'healthy' | 'warning' | 'danger' | 'neutral'
  readonly label: string
}

export function describeProviderStatus(keys: readonly KeyView[]): ProviderStatus {
  if (keys.length === 0) return { tone: 'neutral', label: 'No keys' }
  const tones = keys.map((key) => healthTone(key.health))
  if (tones.every((tone) => tone === 'healthy')) return { tone: 'healthy', label: 'Healthy' }
  if (tones.some((tone) => tone === 'danger')) return { tone: 'warning', label: 'Degraded' }
  return { tone: 'warning', label: 'Partial' }
}