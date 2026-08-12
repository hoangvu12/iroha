export function formatTime(
  iso: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'short', timeStyle: 'medium' },
): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return 'unknown'
  const local = at.toLocaleString(undefined, options)
  const utc = at.toLocaleString(undefined, utcFormatOptions(options))
  return `${local} (${utc})`
}

function utcFormatOptions(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormatOptions {
  const hasDate = options.year !== undefined || options.month !== undefined || options.day !== undefined || options.weekday !== undefined
  const hasTime = options.hour !== undefined || options.minute !== undefined || options.second !== undefined
  const utc: Intl.DateTimeFormatOptions = { timeZone: 'UTC', timeZoneName: 'short' }

  if (hasDate) {
    if (options.weekday !== undefined) utc.weekday = options.weekday
    if (options.year !== undefined) utc.year = options.year
    if (options.month !== undefined) utc.month = options.month
    if (options.day !== undefined) utc.day = options.day
  } else {
    utc.year = 'numeric'
    switch (options.dateStyle) {
      case 'full':
        utc.weekday = 'long'
        utc.month = 'long'
        utc.day = 'numeric'
        break
      case 'long':
        utc.month = 'long'
        utc.day = 'numeric'
        break
      case 'medium':
        utc.month = 'short'
        utc.day = 'numeric'
        break
      case 'short':
        utc.month = '2-digit'
        utc.day = 'numeric'
        break
    }
  }

  if (hasTime) {
    if (options.hour !== undefined) utc.hour = options.hour
    if (options.minute !== undefined) utc.minute = options.minute
    if (options.second !== undefined) utc.second = options.second
  } else {
    utc.hour = 'numeric'
    utc.minute = '2-digit'
    if (options.timeStyle === 'long' || options.timeStyle === 'medium') utc.second = '2-digit'
  }

  return utc
}
