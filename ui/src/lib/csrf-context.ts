import { createContext, useContext } from 'react'
import type { AuthState } from '@/lib/auth'

export interface CsrfContextValue {
  readonly csrfToken: string
  readonly onSignedOut: () => void
  readonly authState: AuthState
}

export const CsrfContext = createContext<CsrfContextValue | null>(null)

export function useCsrf(): CsrfContextValue {
  const value = useContext(CsrfContext)
  if (value === null) {
    throw new Error('useCsrf must be used inside a CsrfContext.Provider')
  }
  return value
}