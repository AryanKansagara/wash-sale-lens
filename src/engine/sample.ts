// Synthetic traders. Every sample is emitted as real broker CSV text and goes through the same importer
// a user's files do. Names, trades and prices are invented; tickers are real so the stories read naturally.
import { addDays } from './dates.ts'
import type { Account, AccountType, Broker, Settings } from './types.ts'
import { DEFAULT_SETTINGS } from './types.ts'

interface T { a: string; d: string; k: 'buy' | 'sell' | 'div' | 'drip' | 'split'; s: string; q?: number; usd?: number; p?: number; auto?: boolean }
export interface SampleDef {
  id: string
  name: string
  person: string
  blurb: string
  story: string
  accounts: (Account & { file: string })[]
  settings: Settings
  trades: T[]
  /** Planner prices as of the sample's "today". */
  prices: Record<string, number>
  focusYear: number
}

const INFO: Record<string, [string, string]> = {
  PLTR: ['Palantir Technologies', '69608A108'], AAPL: ['Apple', '037833100'], SOFI: ['SoFi Technologies', '83406F102'], NVDA: ['NVIDIA', '67066G104'],
  TSLA: ['Tesla', '88160R101'], AMD: ['Advanced Micro Devices', '007903107'], VOO: ['Vanguard S&P 500 ETF', '922908363'], IVV: ['iShares Core S&P 500 ETF', '464287200'],
  SCHD: ['Schwab US Dividend Equity ETF', '808524797'], MSFT: ['Microsoft', '594918104'], VTI: ['Vanguard Total Stock Market ETF', '922908769'],
}

// Price paths: anchor points linearly interpolated, plus a small deterministic wiggle.
const PATHS: Record<string, [string, number][]> = {
  PLTR: [['2025-01-01', 76], ['2025-02-20', 66], ['2025-03-28', 59], ['2025-04-07', 52], ['2025-05-12', 62], ['2025-08-01', 74], ['2025-11-10', 61], ['2026-03-01', 70], ['2026-09-01', 64], ['2026-11-08', 55]],
  AAPL: [['2025-01-01', 243], ['2025-04-08', 172], ['2025-09-01', 229], ['2026-11-08', 251]],
  SOFI: [['2025-01-01', 15.4], ['2025-04-07', 10.2], ['2025-07-01', 19.5], ['2026-05-01', 17], ['2026-11-08', 12.8]],
  NVDA: [['2025-01-01', 138], ['2025-04-04', 94.3], ['2025-04-15', 112], ['2025-08-01', 176], ['2026-11-08', 158]],
  TSLA: [['2025-01-01', 400], ['2025-02-03', 383], ['2025-03-10', 222], ['2025-03-20', 236], ['2025-06-23', 348], ['2026-11-08', 301]],
  AMD: [['2025-01-01', 122], ['2025-03-03', 101], ['2025-04-08', 81], ['2025-04-21', 88], ['2025-10-01', 160], ['2026-11-08', 128]],
  VOO: [['2024-06-01', 485], ['2024-07-15', 562], ['2025-02-19', 561], ['2025-04-08', 456], ['2025-07-01', 570], ['2026-03-01', 598], ['2026-10-01', 571], ['2026-11-08', 548]],
  IVV: [['2024-06-01', 528], ['2025-02-19', 611], ['2025-04-08', 497], ['2025-07-01', 621], ['2026-03-01', 651], ['2026-11-08', 597]],
  SCHD: [['2024-06-01', 26.4], ['2025-01-01', 27.8], ['2025-04-04', 24.6], ['2025-07-01', 27.1], ['2026-11-08', 25.9]],
  MSFT: [['2025-01-01', 421], ['2025-12-01', 488], ['2026-11-08', 512]],
  VTI: [['2025-01-01', 290], ['2026-11-08', 318]],
}

export function priceOn(sym: string, d: string): number {
  const path = PATHS[sym]
  let p = path[path.length - 1][1]
  for (let i = 0; i < path.length - 1; i++) {
    const [d0, p0] = path[i], [d1, p1] = path[i + 1]
    if (d >= d0 && d <= d1) {
      const f = (Date.parse(d) - Date.parse(d0)) / (Date.parse(d1) - Date.parse(d0) || 1)
      p = p0 + (p1 - p0) * f
      break
    }
    if (d < path[0][0]) p = path[0][1]
  }
  let h = 0
  for (const c of sym + d) h = (h * 31 + c.charCodeAt(0)) >>> 0
  const wiggle = ((h % 1000) / 1000 - 0.5) * 0.024
  return Math.round(p * (1 + wiggle) * 100) / 100
}

const isMonday = (d: string) => new Date(d + 'T00:00:00Z').getUTCDay() === 1
function every(from: string, to: string, step: number, f: (d: string) => T | null): T[] {
  const out: T[] = []
  for (let d = from; d <= to; d = addDays(d, step)) { const t = f(d); if (t) out.push(t) }
  return out
}
const weekday = (d: string) => { const w = new Date(d + 'T00:00:00Z').getUTCDay(); return w === 6 ? addDays(d, 2) : w === 0 ? addDays(d, 1) : d }

export const SAMPLES: SampleDef[] = [
  {
    id: 'dip-buyer',
    name: 'Dip buyer',
    person: 'Synthetic trader: Jordan',
    blurb: 'Robinhood only. Buys every PLTR dip, so one loss chains through three rebuys and finally releases in November.',
    story: 'Sold PLTR at a loss four times in 2025 and bought back each time. Robinhood reported a large "wash sale loss disallowed" in box 1g, but almost all of it came back on the final sale. Shows the chain and the release.',
    accounts: [{ id: 'rh', name: 'Robinhood individual', broker: 'robinhood', type: 'taxable', file: 'robinhood-activity-2025-2026.csv' }],
    settings: DEFAULT_SETTINGS,
    focusYear: 2025,
    trades: [
      { a: 'rh', d: '2025-01-06', k: 'buy', s: 'PLTR', q: 40 },
      { a: 'rh', d: '2025-01-13', k: 'buy', s: 'AAPL', q: 8 },
      { a: 'rh', d: '2025-01-21', k: 'buy', s: 'SOFI', q: 150 },
      { a: 'rh', d: '2025-02-24', k: 'sell', s: 'PLTR', q: 40 },
      { a: 'rh', d: '2025-03-05', k: 'buy', s: 'PLTR', q: 40 },
      { a: 'rh', d: '2025-03-28', k: 'sell', s: 'PLTR', q: 40 },
      { a: 'rh', d: '2025-04-07', k: 'buy', s: 'PLTR', q: 50 },
      { a: 'rh', d: '2025-04-07', k: 'sell', s: 'SOFI', q: 150 },
      { a: 'rh', d: '2025-05-12', k: 'sell', s: 'PLTR', q: 50 },
      { a: 'rh', d: '2025-05-20', k: 'buy', s: 'PLTR', q: 30 },
      { a: 'rh', d: '2025-05-15', k: 'div', s: 'AAPL', usd: 2.08 },
      { a: 'rh', d: '2025-09-02', k: 'sell', s: 'AAPL', q: 8 },
      { a: 'rh', d: '2025-11-10', k: 'sell', s: 'PLTR', q: 30 },
      { a: 'rh', d: '2026-02-17', k: 'buy', s: 'SOFI', q: 200 },
      { a: 'rh', d: '2026-03-02', k: 'buy', s: 'PLTR', q: 25 },
      { a: 'rh', d: '2026-09-02', k: 'buy', s: 'PLTR', q: 20 },
      { a: 'rh', d: '2026-10-20', k: 'buy', s: 'PLTR', q: 10 },
      { a: 'rh', d: '2026-03-10', k: 'buy', s: 'MSFT', q: 4 },
    ],
    prices: {},
  },
  {
    id: 'cross-account',
    name: 'Robinhood + Roth IRA',
    person: 'Synthetic trader: Priya',
    blurb: 'Sold NVDA at a loss on Robinhood, then bought NVDA in a Fidelity Roth. Robinhood\'s 1099-B shows nothing; the loss is gone for good.',
    story: 'Three accounts. A Robinhood loss replaced in a Roth IRA (permanently disallowed under Rev. Rul. 2008-5), a Tesla loss replaced at Schwab (deferred, not lost), and an AMD wash sale Robinhood did catch.',
    accounts: [
      { id: 'rh', name: 'Robinhood individual', broker: 'robinhood', type: 'taxable', file: 'robinhood-activity.csv' },
      { id: 'roth', name: 'Fidelity Roth IRA', broker: 'fidelity', type: 'roth', file: 'fidelity-roth-history.csv' },
      { id: 'sch', name: 'Schwab brokerage', broker: 'schwab', type: 'taxable', file: 'schwab-transactions.csv' },
    ],
    settings: DEFAULT_SETTINGS,
    focusYear: 2025,
    trades: [
      { a: 'rh', d: '2025-01-07', k: 'buy', s: 'NVDA', q: 30 },
      { a: 'rh', d: '2025-02-03', k: 'buy', s: 'TSLA', q: 10 },
      { a: 'rh', d: '2025-03-03', k: 'buy', s: 'AMD', q: 25 },
      { a: 'rh', d: '2025-03-10', k: 'sell', s: 'TSLA', q: 10 },
      { a: 'sch', d: '2025-03-20', k: 'buy', s: 'TSLA', q: 10 },
      { a: 'rh', d: '2025-04-04', k: 'sell', s: 'NVDA', q: 30 },
      { a: 'rh', d: '2025-04-08', k: 'sell', s: 'AMD', q: 25 },
      { a: 'roth', d: '2025-04-15', k: 'buy', s: 'NVDA', q: 20 },
      { a: 'rh', d: '2025-04-21', k: 'buy', s: 'AMD', q: 25 },
      { a: 'sch', d: '2025-06-23', k: 'sell', s: 'TSLA', q: 10 },
      { a: 'roth', d: '2025-07-01', k: 'buy', s: 'VTI', q: 12 },
      { a: 'rh', d: '2026-01-12', k: 'buy', s: 'NVDA', q: 15 },
      { a: 'sch', d: '2026-02-02', k: 'buy', s: 'TSLA', q: 8 },
      { a: 'roth', d: '2026-10-27', k: 'buy', s: 'AMD', q: 10 },
    ],
    prices: {},
  },
  {
    id: 'recurring-trap',
    name: 'Recurring-investment trap',
    person: 'Synthetic trader: Sam',
    blurb: 'Weekly $100 VOO auto-buys, a DRIP on SCHD and a Roth buying IVV every month. Harvesting a VOO loss in April quietly washes part of it.',
    story: 'A lump of VOO harvested during the April 2025 dip while a weekly recurring investment kept buying. SCHD sold at a loss with dividend reinvestment on. The S&P 500 ETFs are grouped as equivalents (your call: the IRS has not ruled), so Roth IVV buys wash too.',
    accounts: [
      { id: 'rh', name: 'Robinhood individual', broker: 'robinhood', type: 'taxable', file: 'robinhood-activity.csv' },
      { id: 'sch', name: 'Schwab brokerage', broker: 'schwab', type: 'taxable', file: 'schwab-transactions.csv' },
      { id: 'roth', name: 'Robinhood Roth IRA', broker: 'robinhood', type: 'roth', file: 'robinhood-roth-activity.csv' },
    ],
    settings: { method: 'fifo', equivalents: [['VOO', 'IVV', 'SPLG']] },
    focusYear: 2025,
    trades: [
      { a: 'rh', d: '2024-07-15', k: 'buy', s: 'VOO', q: 20 },
      { a: 'sch', d: '2024-06-24', k: 'buy', s: 'SCHD', q: 400 },
      ...every('2024-06-28', '2026-10-01', 91, d => ({ a: 'sch', d: weekday(d), k: 'drip', s: 'SCHD' })),
      ...every('2025-01-06', '2026-11-02', 7, d => isMonday(d) ? { a: 'rh', d, k: 'buy', s: 'VOO', usd: 100, auto: true } : null),
      ...every('2025-01-15', '2026-10-15', 1, d => d.endsWith('-15') ? { a: 'roth', d: weekday(d), k: 'buy', s: 'IVV', usd: 250, auto: true } : null),
      { a: 'rh', d: '2025-04-08', k: 'sell', s: 'VOO', q: 20 },
      { a: 'sch', d: '2025-04-04', k: 'sell', s: 'SCHD', q: 250 },
    ],
    prices: {},
  },
]
for (const s of SAMPLES) {
  const syms = new Set(s.trades.map(t => t.s))
  s.prices = Object.fromEntries([...syms].map(x => [x, priceOn(x, '2026-11-06')]))
}

// ---------- Emitting broker files ----------

interface Row { d: string; kind: 'buy' | 'sell' | 'div' | 'drip' | 'split' | 'drip-cash'; s: string; q: number; p: number; amt: number; auto?: boolean }

function expand(def: SampleDef, accountId: string): Row[] {
  const held = new Map<string, number>()
  const rows: Row[] = []
  const trades = def.trades.filter(t => t.a === accountId).sort((a, b) => a.d.localeCompare(b.d))
  for (const t of trades) {
    const p = t.p ?? priceOn(t.s, t.d)
    const h = held.get(t.s) ?? 0
    if (t.k === 'buy') {
      const q = t.q ?? Math.round((t.usd! / p) * 1e6) / 1e6
      const amt = t.q ? Math.round(q * p * 100) / 100 : t.usd!
      rows.push({ d: t.d, kind: 'buy', s: t.s, q, p, amt, auto: t.auto }); held.set(t.s, h + q)
    } else if (t.k === 'sell') {
      const q = Math.min(t.q ?? h, h)
      rows.push({ d: t.d, kind: 'sell', s: t.s, q, p, amt: Math.round(q * p * 100) / 100 }); held.set(t.s, h - q)
    } else if (t.k === 'div') rows.push({ d: t.d, kind: 'div', s: t.s, q: 0, p: 0, amt: t.usd! })
    else if (t.k === 'drip') {
      if (h <= 0) continue
      const cash = Math.round(h * 0.26 * 100) / 100
      const q = Math.round((cash / p) * 1e6) / 1e6
      rows.push({ d: t.d, kind: 'drip-cash', s: t.s, q: 0, p: 0, amt: cash })
      rows.push({ d: t.d, kind: 'drip', s: t.s, q, p, amt: cash }); held.set(t.s, h + q)
    }
  }
  return rows
}

const mdy = (d: string) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}/${d.slice(0, 4)}`
const mdy2 = (d: string) => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`
const money = (v: number) => (v < 0 ? '($' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (v < 0 ? ')' : '')
const q = (s: string) => /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
const line = (cells: (string | number)[]) => cells.map(c => q(String(c))).join(',')
const fmtQ = (n: number) => String(Math.round(n * 1e6) / 1e6)

function robinhood(rows: Row[]): string {
  const out = [line(['Activity Date', 'Process Date', 'Settle Date', 'Instrument', 'Description', 'Trans Code', 'Quantity', 'Price', 'Amount'])]
  const body = rows.map(r => {
    const [name, cusip] = INFO[r.s]
    const settle = mdy(addDays(r.d, r.kind === 'buy' || r.kind === 'sell' ? 1 : 0))
    if (r.kind === 'div') return line([mdy(r.d), mdy(r.d), settle, r.s, `Cash Div: R/D ${mdy(addDays(r.d, -10))} P/D ${mdy(r.d)} - ${r.s}`, 'CDIV', '', '', money(r.amt)])
    const desc = `${name}${r.auto ? ' Recurring' : ''}\nCUSIP: ${cusip}`
    return line([mdy(r.d), mdy(r.d), settle, r.s, desc, r.kind === 'sell' ? 'Sell' : 'Buy', fmtQ(r.q), money(r.p), money(r.kind === 'sell' ? r.amt : -r.amt)])
  }).reverse()
  const deposits = [line([mdy('2025-01-02'), mdy('2025-01-02'), mdy('2025-01-02'), '', 'ACH Deposit', 'ACH', '', '', money(5000)])]
  return [...out, ...body, ...deposits, '', '"The data provided is for informational purposes only. Please consult a professional tax service or personal tax advisor if you need instructions on how to calculate cost basis or questions regarding your specific tax situation. Reminder: This data does not include Robinhood Crypto or Robinhood Spending activity."'].join('\n') + '\n'
}

function fidelity(rows: Row[]): string {
  const head = line(['Run Date', 'Action', 'Symbol', 'Description', 'Type', 'Quantity', 'Price ($)', 'Commission ($)', 'Fees ($)', 'Accrued Interest ($)', 'Amount ($)', 'Settlement Date'])
  const body = rows.filter(r => r.kind === 'buy' || r.kind === 'sell').map(r => {
    const name = INFO[r.s][0].toUpperCase()
    const act = r.kind === 'buy' ? `YOU BOUGHT ${name} (${r.s}) (Cash)` : `YOU SOLD ${name} (${r.s}) (Cash)`
    return line([mdy2(r.d), act, r.s, name, 'Cash', r.kind === 'buy' ? fmtQ(r.q) : `-${fmtQ(r.q)}`, r.p.toFixed(2), '', '', '', (r.kind === 'buy' ? -r.amt : r.amt).toFixed(2), mdy2(addDays(r.d, 1))])
  }).reverse()
  return ['', '', head, ...body, '', '', '"The data and information in this spreadsheet is provided to you solely for your use and is not for distribution."', '"Brokerage services are provided by Fidelity Brokerage Services LLC (FBS), 900 Salem Street, Smithfield, RI 02917."', `"Date downloaded ${mdy2('2026-11-06')} 9:14 pm"`].join('\n') + '\n'
}

function schwab(rows: Row[]): string {
  const head = line(['Date', 'Action', 'Symbol', 'Description', 'Quantity', 'Price', 'Fees & Comm', 'Amount'])
  const body = rows.map(r => {
    const name = INFO[r.s][0].toUpperCase()
    if (r.kind === 'drip-cash') return line([mdy2(r.d), 'Reinvest Dividend', r.s, name, '', '', '', money(r.amt)])
    if (r.kind === 'div') return line([mdy2(r.d), 'Qualified Dividend', r.s, name, '', '', '', money(r.amt)])
    if (r.kind === 'drip') return line([mdy2(r.d), 'Reinvest Shares', r.s, name, fmtQ(r.q), money(r.p), '', money(-r.amt)])
    return line([mdy2(r.d), r.kind === 'buy' ? 'Buy' : 'Sell', r.s, name, fmtQ(r.q), money(r.p), '', money(r.kind === 'buy' ? -r.amt : r.amt)])
  }).reverse()
  return [head, ...body].join('\n') + '\n'
}

const EMIT: Record<Broker, (rows: Row[]) => string> = { robinhood, fidelity, schwab, ibkr: schwab, generic: schwab }

export function sampleFiles(def: SampleDef): { account: SampleDef['accounts'][number]; name: string; text: string }[] {
  return def.accounts.map(a => ({ account: a, name: a.file, text: EMIT[a.broker](expand(def, a.id)) }))
}

export const ACCOUNT_TYPES: Record<AccountType, string> = { taxable: 'Taxable brokerage', ira: 'Traditional IRA', roth: 'Roth IRA' }
