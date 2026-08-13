export function formatTime(
  iso: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'short', timeStyle: 'short' },
): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return 'unknown'
  return at.toLocaleString(undefined, options)
}