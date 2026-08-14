import { useEffect, useState } from 'react'

function isDark(): boolean {
  return document.documentElement.classList.contains('dark')
}

/**
 * Tracks whether the `dark` class is currently applied to `<html>`. The theme
 * toggle writes that class directly (see `use-theme`), so observing it covers
 * light, dark, and system themes — including a live OS switch — from a single
 * source of truth. Components that need the resolved mode (e.g. to pick a
 * logo variant) can re-render whenever it flips.
 */
export function useIsDarkMode(): boolean {
  const [dark, setDark] = useState(isDark)

  useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => setDark(isDark()))
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  return dark
}
