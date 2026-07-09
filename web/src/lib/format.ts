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
 * Minor units (senti, BIGINT-safe string/number/bigint) → "TZS 150,000".
 * TZS is displayed as whole numbers; the senti remainder is dropped for
 * display (amounts are integral senti and TZS has no circulating cents).
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
  const major = (negative ? -value : value) / 100n
  const grouped = major
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '-' : ''}${currency} ${grouped}`
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
