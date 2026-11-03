import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { ModelDiscoveryMode } from '@/lib/providers'

/** The select's value for "no override": the Provider Template decides. */
type ModelDiscoveryChoice = ModelDiscoveryMode | 'inherit'

export const MODEL_DISCOVERY_LABELS: Record<ModelDiscoveryChoice, string> = {
  inherit: 'Template default',
  supported: 'Read GET /models',
  best_effort: 'Best effort',
  unsupported: 'Off — models added by hand',
}

const HINTS: Record<ModelDiscoveryChoice, string> = {
  inherit: 'Use whatever the provider template declares.',
  supported: 'Discover models from GET /models and test keys against it.',
  best_effort: 'Try GET /models, but fall back to template models when it fails.',
  unsupported:
    'Never call GET /models. Add models by hand in the catalog; keys are trusted until a request refuses them.',
}

const CHOICES: readonly ModelDiscoveryChoice[] = ['inherit', 'supported', 'best_effort', 'unsupported']

export function ModelDiscoverySelect({
  id,
  value,
  onChange,
  problem,
}: {
  readonly id: string
  readonly value: ModelDiscoveryMode | null
  readonly onChange: (value: ModelDiscoveryMode | null) => void
  readonly problem?: string | undefined
}) {
  const choice: ModelDiscoveryChoice = value ?? 'inherit'

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Model list</Label>
      <Select
        value={choice}
        onValueChange={(next) => onChange(next === 'inherit' ? null : (next as ModelDiscoveryMode))}
      >
        <SelectTrigger id={id} className="w-full" size="sm">
          <SelectValue>{MODEL_DISCOVERY_LABELS[choice]}</SelectValue>
        </SelectTrigger>
        <SelectContent align="start">
          {CHOICES.map((option) => (
            <SelectItem key={option} value={option} textValue={MODEL_DISCOVERY_LABELS[option]}>
              {MODEL_DISCOVERY_LABELS[option]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-muted-foreground text-xs">{HINTS[choice]}</p>
      {problem && <p className="text-status-danger text-xs">{problem}</p>}
    </div>
  )
}
