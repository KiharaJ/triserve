/**
 * Formatting utilities (Task 0.7, DESIGN.md conventions):
 *  - Money: BIGINT minor units ("senti") on the wire, shown as WHOLE TZS
 *    (divide by 100, no decimals) — never floats.
 *  - Dates: rendered in Africa/Dar_es_Salaam regardless of browser zone.
 */

const TIME_ZONE = 'Africa/Dar_es_Salaam'

const dateTimeFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

const dateFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
})

/** "09 Jul 2026, 14:03" in Africa/Dar_es_Salaam. */
export function formatDateTime(iso: string | Date | null | undefined): string {
  if (!iso) return '—'
  return dateTimeFormat.format(typeof iso === 'string' ? new Date(iso) : iso)
}

/** "09 Jul 2026" in Africa/Dar_es_Salaam. */
export function formatDate(iso: string | Date | null | undefined): string {
  if (!iso) return '—'
  return dateFormat.format(typeof iso === 'string' ? new Date(iso) : iso)
}

/**
 * Currencies displayed as WHOLE numbers (no circulating minor unit). TZS has no
 * cents in practice; everything else (USD, EUR…) shows 2 decimal places.
 */
const ZERO_DECIMAL_CURRENCIES = new Set(['TZS'])

/**
 * Minor units (BIGINT-safe string/number/bigint) → display string, e.g.
 * "TZS 150,000" or "USD 57.68". TZS is whole (the senti remainder is dropped);
 * USD and other currencies keep 2 decimals (cents), so IW claim values aren't
 * rounded off.
 */
export function formatMoney(
  minor: string | number | bigint | null | undefined,
  currency = 'TZS',
): string {
  if (minor === null || minor === undefined || minor === '') return '—'
  let value: bigint
  try {
    value = BigInt(minor)
  } catch {
    return '—'
  }
  const negative = value < 0n
  const abs = negative ? -value : value
  const whole = abs / 100n
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const sign = negative ? '-' : ''
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) {
    return `${sign}${currency} ${grouped}`
  }
  const cents = (abs % 100n).toString().padStart(2, '0')
  return `${sign}${currency} ${grouped}.${cents}`
}

/**
 * Whole-dollar/decimal input ("57" or "57.68") → USD minor-unit (cent) string
 * ("5700" / "5768"). Returns null for blank; throws on bad input. Unlike
 * {@link majorToMinor} (TZS, whole units) this accepts up to 2 decimals.
 */
export function decimalToMinor(input: string): string | null {
  const trimmed = input.trim().replace(/,/g, '')
  if (trimmed === '') return null
  const m = trimmed.match(/^(\d+)(?:\.(\d{1,2}))?$/)
  if (!m) {
    throw new Error('Enter an amount, e.g. 57.68')
  }
  const cents = (m[2] ?? '').padEnd(2, '0')
  return (BigInt(m[1]) * 100n + BigInt(cents || '0')).toString()
}

/** USD cent string → decimal major string ("5768" → "57.68") for inputs. */
export function minorToDecimal(minor: string | null | undefined): string {
  if (!minor) return ''
  try {
    const v = BigInt(minor)
    const neg = v < 0n
    const abs = neg ? -v : v
    return `${neg ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`
  } catch {
    return ''
  }
}

/**
 * Whole-major-unit input string ("150000") → minor-units wire string
 * ("15000000"). Returns null for blank input; throws on non-numeric.
 */
export function majorToMinor(input: string): string | null {
  const trimmed = input.trim().replace(/,/g, '')
  if (trimmed === '') return null
  if (!/^\d+$/.test(trimmed)) {
    throw new Error('Enter a whole amount, e.g. 150000')
  }
  return (BigInt(trimmed) * 100n).toString()
}

/** Minor-units wire string → whole-major string for form inputs. */
export function minorToMajor(minor: string | null | undefined): string {
  if (!minor) return ''
  try {
    return (BigInt(minor) / 100n).toString()
  } catch {
    return ''
  }
}

/**
 * Elapsed time since an ISO timestamp as a compact age label ("42m", "3h",
 * "5d") — used on Kanban cards (Task 1.5). Real elapsed time, so it is not
 * timezone-sensitive; only formatDate/formatDateTime need the TZ.
 */
export function formatAge(iso: string | null | undefined): string {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms) || ms < 0) return '0m'
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}
