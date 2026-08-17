import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ProviderIcon } from '@/components/provider-icon'
import { normalizeLogoDomainInput } from '@/lib/logo-domain'

export function LogoDomainField({
  id,
  value,
  onChange,
  problem,
}: {
  readonly id: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly problem?: string
}) {
  const normalized = normalizeLogoDomainInput(value)
  const empty = value.trim() === ''
  const invalid = !empty && normalized === null
  const [previewDomain, setPreviewDomain] = useState<string | null>(normalized)
  const [clientProblem, setClientProblem] = useState<string | undefined>()

  useEffect(() => {
    if (empty || invalid) {
      setPreviewDomain(null)
      return
    }
    const timer = window.setTimeout(() => setPreviewDomain(normalized), 300)
    return () => window.clearTimeout(timer)
  }, [empty, invalid, normalized])

  useEffect(() => {
    if (!invalid) {
      setClientProblem(undefined)
      return
    }
    const timer = window.setTimeout(
      () => setClientProblem('Enter a valid hostname or HTTP(S) URL.'),
      300,
    )
    return () => window.clearTimeout(timer)
  }, [invalid, value])

  const inlineProblem = problem ?? clientProblem
  const describedBy = inlineProblem ? `${id}-problem` : undefined

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Logo domain</Label>
      <div className="flex min-w-0 items-center gap-2">
        <ProviderIcon logoDomain={empty || invalid ? null : previewDomain} />
        <div className="relative min-w-0 flex-1">
          <Input
            id={id}
            value={value}
            className={empty ? undefined : 'pe-9'}
            placeholder="example.com"
            autoComplete="url"
            aria-invalid={inlineProblem ? true : undefined}
            aria-describedby={describedBy}
            onChange={(event) => onChange(event.target.value)}
          />
          {!empty && (
            <button
              type="button"
              aria-label="Clear Logo domain"
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring absolute inset-y-0 end-0 flex w-9 items-center justify-center rounded-e-md focus-visible:ring-2 focus-visible:outline-none"
              onClick={() => onChange('')}
            >
              <X className="size-3.5" aria-hidden />
            </button>
          )}
        </div>
      </div>
      {inlineProblem && <p id={`${id}-problem`} className="text-status-danger text-xs">{inlineProblem}</p>}
    </div>
  )
}
