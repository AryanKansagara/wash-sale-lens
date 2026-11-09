// Calendar math on ISO dates (YYYY-MM-DD), always in UTC so time zones never shift a trade date.

const DAY = 86400000
const t = (d: string) => Date.parse(d + 'T00:00:00Z')
export const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)

export const addDays = (d: string, n: number) => iso(t(d) + n * DAY)
export const diffDays = (a: string, b: string) => Math.round((t(b) - t(a)) / DAY)

/** Same calendar date n years later; Feb 29 rolls to Feb 28. */
export function addYears(d: string, n: number): string {
  const [y, m, day] = d.split('-').map(Number)
  const last = new Date(Date.UTC(y + n, m, 0)).getUTCDate()
  return `${y + n}-${String(m).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`
}

/** Long term means held more than one year: sold after the one-year anniversary of the holding start (Pub 550). */
export const isLongTerm = (holdingStart: string, sold: string) => sold > addYears(holdingStart, 1)

/** Parses the date formats brokers export: 1/2/2025, 01/02/25, 2025-01-02, 20250102, "01/02/2025 as of 12/31/2024", Jan 2, 2025. */
export function parseDate(raw: string): string | null {
  const s = raw.trim().replace(/^"|"$/g, '').split(/\s+as of\s+/i)[0].trim()
  if (!s) return null
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (m) return ymd(+m[1], +m[2], +m[3])
  m = s.match(/^(\d{4})(\d{2})(\d{2})(?:[;,\s].*)?$/)
  if (m) return ymd(+m[1], +m[2], +m[3])
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/)
  if (m) return ymd(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1], +m[2])
  m = s.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})/)
  if (m) {
    const mo = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[1].toLowerCase())
    if (mo >= 0) return ymd(+m[3], mo + 1, +m[2])
  }
  return null
}

function ymd(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1970 || y > 2100) return null
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCMonth() !== m - 1) return null
  return iso(dt.getTime())
}

/** "$1,234.56", "($1,234.56)", "-1234.56", "1,234.56-" to a number. NaN when not a number. */
export function parseNum(raw: string | undefined): number {
  if (raw === undefined) return NaN
  let s = raw.trim().replace(/^"|"$/g, '')
  if (!s || s === '--' || s === '-') return NaN
  let neg = false
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1) }
  if (s.endsWith('-')) { neg = true; s = s.slice(0, -1) }
  s = s.replace(/[$,\s]|USD/g, '')
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1) }
  if (s.startsWith('+')) s = s.slice(1)
  if (!/^\d*\.?\d+(e[+-]?\d+)?$/i.test(s)) return NaN
  const v = Number(s)
  return neg ? -v : v
}
