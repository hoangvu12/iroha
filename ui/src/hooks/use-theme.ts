import { useCallback, useEffect, useState } from 'react'

export type ThemePreference = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'iroha.theme'

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  } catch {
    // Private-mode browsers deny storage; the default preference still works.
  }
  return 'system'
}

function applyPreference(preference: ThemePreference): void {
  const dark =
    preference === 'dark' ||
    (preference === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
}

/**
 * Light, dark, and system themes. `index.html` applies the stored preference
 * before first paint; this hook keeps it in sync afterwards, including when the
 * operating system switches while Iroha is open.
 */
export function useTheme() {
  const [preference, setPreferenceState] = useState<ThemePreference>(readPreference)

  useEffect(() => {
    applyPreference(preference)

    if (preference !== 'system') return

    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyPreference('system')
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [preference])

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // A theme that does not survive a reload is better than a crash.
    }
  }, [])

  return { preference, setPreference }
}
